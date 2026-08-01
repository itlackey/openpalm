/**
 * Shared setup orchestration for the OpenPalm control plane.
 *
 * Both the CLI setup wizard and the admin UI call `performSetup()`.
 * This module does NOT include Docker operations (compose up, image pull, etc.)
 * — those happen separately in the caller after setup completes.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { errMessage } from './errors.js';
import { join } from 'node:path';
import { createLogger } from '../logger.js';
import { writeFileAtomic } from './fs-atomic.js';
import { enableHostAkmSharing, disableHostAkmSharing } from './host-akm-sharing.js';
import { addHostStashToOpenpalmConfig } from './akm-sources.js';
import { PROVIDER_KEY_MAP } from '../provider-constants.js';
import { buildAkmEndpoint } from './akm-endpoints.js';
import { SERVICE_VERSION_KEYS, VERSION_DEFAULTS, writeManagedVersions, writeVersions } from './versions.js';
import { PLATFORM_VERSION } from './versioning.js';
import { ensureHomeDirs } from './home.js';
import { acquireInstallLock, releaseInstallLock, type InstallLockHandle } from './install-lock.js';
import {
	ensureSecrets,
	updateSecretsEnv,
	patchSecretsEnvFile,
	ensureOpenCodeConfig,
	writeAuthJsonProviderKeys,
	readStackEnv
} from './secrets.js';
import { createState, initializeStateSecrets } from './lifecycle.js';
import { readSecret } from './secrets-files.js';
import type { ControlPlaneState } from './types.js';
import { validateSetupSpec } from './setup-validation.js';
import {
	getRegistryAutomation,
	setAddonEnabled,
	setAddonProfileSelection
} from './addons.js';
import { reconcileGuardianIngressAddons } from './access-apply.js';
import {
	coerceAccessToggles,
	requiresAssistantKey,
	resolveAccessEnv,
	resolveAccessIntentEnv,
	type AccessToggles
} from './access-toggles.js';
import { randomHex } from './crypto.js';
export { validateSetupSpec } from './setup-validation.js';

const logger = createLogger('setup');

// ── Types ────────────────────────────────────────────────────────────────

export type SetupConnection = {
	id: string;
	name: string;
	provider: string;
	baseUrl: string;
	apiKey: string;
};

export type SetupResult = {
	ok: boolean;
	error?: string;
	started?: string[];
};

export type SetupSpec = {
	version: 2;
	llm?: { provider: string; model: string; baseUrl?: string };
	embedding?: { provider: string; model: string; dims: number; baseUrl?: string };
	/**
	 * Operator-supplied UI login password. Persisted as a file-based secret.
	 */
	security: { uiLoginPassword?: string };
	owner?: { name?: string; email?: string };
	connections: SetupConnection[];
	portalCredentials?: Record<string, Record<string, string>>;
	addons?: Record<string, boolean>;
	voiceProfile?: string;
	ollamaProfile?: string;
	imageTag?: string;
	hostAkm?: boolean;
	/**
	 * Network access toggles. Absent = leave network config untouched, so a
	 * rerun the operator did not touch never rewrites their exposure.
	 */
	access?: Partial<AccessToggles>;
};

// ── Secrets Builder ──────────────────────────────────────────────────────

/**
 * Build the non-secret stack.env update payload from a setup spec.
 * Extracts owner name/email into OP_OWNER_* env vars.
 */
export function buildOwnerEnvFromSetup(owner?: {
	name?: string;
	email?: string;
}): Record<string, string> {
	const updates: Record<string, string> = {};
	const ownerName = (owner?.name?.trim() ?? '').replace(/[\r\n\0]/g, '').slice(0, 200);
	const ownerEmail = (owner?.email?.trim() ?? '').replace(/[\r\n\0]/g, '').slice(0, 200);
	if (ownerName) updates.OP_OWNER_NAME = ownerName;
	if (ownerEmail) updates.OP_OWNER_EMAIL = ownerEmail;
	return updates;
}

/**
 * Build the auth.json payload from a setup spec. Returns a record of
 * `{ providerId: apiKey }` ready to feed into writeAuthJsonProviderKeys.
 * Pulls keys from the spec first, falling back to the host process
 * environment for the canonical env var name (e.g. OPENAI_API_KEY for
 * provider "openai") so operators can preload keys via env before
 * running the wizard.
 */
export function buildAuthJsonFromSetup(connections: SetupConnection[]): Record<string, string> {
	const keys: Record<string, string> = {};
	for (const cap of connections) {
		const envVar = PROVIDER_KEY_MAP[cap.provider];
		const key = cap.apiKey || (envVar ? process.env[envVar] : undefined) || '';
		if (key) keys[cap.provider] = key;
	}
	return keys;
}

// ── Portal Credential Env Var Mapping ───────────────────────────────────

const PORTAL_CREDENTIAL_ENV_MAP: Record<string, Record<string, string>> = {
	discord: {
		botToken: 'DISCORD_BOT_TOKEN',
		applicationId: 'DISCORD_APPLICATION_ID',
		registerCommands: 'DISCORD_REGISTER_COMMANDS',
		allowedGuilds: 'DISCORD_ALLOWED_GUILDS',
		allowedRoles: 'DISCORD_ALLOWED_ROLES',
		allowedUsers: 'DISCORD_ALLOWED_USERS',
		blockedUsers: 'DISCORD_BLOCKED_USERS'
	},
	slack: {
		slackBotToken: 'SLACK_BOT_TOKEN',
		slackAppToken: 'SLACK_APP_TOKEN',
		allowedChannels: 'SLACK_ALLOWED_CHANNELS',
		allowedUsers: 'SLACK_ALLOWED_USERS',
		blockedUsers: 'SLACK_BLOCKED_USERS'
	}
};

function buildPortalCredentialEnvVars(
	portalCredentials: Record<string, Record<string, string>>
): Record<string, string> {
	const envVars: Record<string, string> = {};
	for (const [portalId, creds] of Object.entries(portalCredentials)) {
		const mapping = PORTAL_CREDENTIAL_ENV_MAP[portalId];
		if (!mapping) continue;
		for (const [field, envKey] of Object.entries(mapping)) {
			const val = creds[field];
			if (typeof val === 'string' && val) envVars[envKey] = val;
		}
	}
	return envVars;
}

// ── AKM Config Persistence ───────────────────────────────────────────────

/**
 * Typed shape of the assistant's akm config.json. This replaces the nested
 * `as Record<string, unknown>` casts that used to hand-manipulate the JSON in
 * performSetup. Every field is optional because we merge over whatever the
 * operator (or a prior run) already wrote — extra/unknown keys are preserved
 * verbatim via the index signature.
 */
export type AkmLlmProfile = {
	endpoint: string;
	model: string;
	provider: string;
	[key: string]: unknown;
};

export type AkmEmbeddingConfig = {
	endpoint: string;
	model: string;
	provider: string;
	dimension: number;
	[key: string]: unknown;
};

export type AkmConfig = {
	profiles?: { llm?: Record<string, AkmLlmProfile>; [key: string]: unknown };
	defaults?: { llm?: string; [key: string]: unknown };
	embedding?: AkmEmbeddingConfig;
	stashDir?: string;
	/** Legacy 0.7 top-level key — read for migration awareness, never persisted. */
	llm?: unknown;
	[key: string]: unknown;
};

/**
 * Merge the setup wizard's LLM + embedding selections into the assistant's
 * akm config.json (atomic write). Existing operator keys — sibling profiles,
 * `sources`, custom fields — are preserved. No-op when neither llm nor
 * embedding is supplied.
 *
 * Writes the CANONICAL akm 0.8.0 shape: profiles.llm.default + defaults.llm.
 * The runtime resolver reads profiles.llm[defaults.llm] (akm config.ts).
 * Do NOT write a top-level `llm` — akm's top-level schema is .strict() with no
 * `llm` key (config-schema.ts AkmConfigShape). A top-level `llm` only loads
 * today via akm's legacy 0.7→0.8 migration shim (config-migration.ts), which
 * rewrites the file on load and is marked for removal — writing the native
 * shape removes that dependency, so any pre-existing legacy key is dropped.
 */
export function persistAkmConfig(
	state: ControlPlaneState,
	opts: { llm?: SetupSpec['llm']; embedding?: SetupSpec['embedding'] }
): void {
	const { llm, embedding } = opts;
	if (!llm && !embedding) return;

	const akmConfigDir = join(state.configDir, 'akm');
	mkdirSync(akmConfigDir, { recursive: true });
	const akmConfigPath = join(akmConfigDir, 'config.json');

	let existing: AkmConfig = {};
	if (existsSync(akmConfigPath)) {
		try {
			existing = JSON.parse(readFileSync(akmConfigPath, 'utf-8')) as AkmConfig;
		} catch {
			/* ignore corrupt */
		}
	}
	const updated: AkmConfig = { ...existing };

	if (llm) {
		const profiles = updated.profiles ?? {};
		const llmProfiles = profiles.llm ?? {};
		llmProfiles.default = {
			...(llmProfiles.default ?? {}),
			endpoint: buildAkmEndpoint(llm.provider, llm.baseUrl, '/chat/completions'),
			model: llm.model,
			provider: llm.provider
		};
		profiles.llm = llmProfiles;
		updated.profiles = profiles;
		const defaults = updated.defaults ?? {};
		if (typeof defaults.llm !== 'string') defaults.llm = 'default';
		updated.defaults = defaults;
		delete updated.llm; // never persist the legacy key
	}

	if (embedding) {
		updated.embedding = {
			...(existing.embedding ?? {}),
			endpoint: buildAkmEndpoint(embedding.provider, embedding.baseUrl, '/embeddings'),
			model: embedding.model,
			provider: embedding.provider,
			dimension: embedding.dims
		};
	}

	// The assistant's primary stash is ALWAYS /stash (the bind mount). Pin it in
	// config so it is explicit and operator-edits can't repoint it; the UI does
	// not expose stashDir. (The host task-runner still uses its own
	// AKM_STASH_DIR env, which takes precedence over config.stashDir.)
	updated.stashDir = '/stash';
	writeFileAtomic(akmConfigPath, JSON.stringify(updated, null, 2), 0o600);
}

/**
 * Persist portal (discord/slack/…) credentials into the vault secrets env.
 * Credential values come ONLY from the setup spec. PR #564 second retest P1-3:
 * the previous host-process-env fallback silently consumed ambient variables
 * (e.g. a leftover `DISCORD_BOT_TOKEN` in the operator's shell) as operator
 * input, overwriting an existing secret BEFORE keep-existing semantics could
 * preserve it. Omitting a credential now leaves the persisted secret untouched
 * — updateSecretsEnv only writes the keys explicitly supplied.
 */
function persistPortalCredentials(
	state: ControlPlaneState,
	portalCredentials?: Record<string, Record<string, string>>
): void {
	const portalSecretUpdates = portalCredentials
		? buildPortalCredentialEnvVars(portalCredentials)
		: {};
	updateSecretsEnv(state, portalSecretUpdates);
}

/**
 * Seed the default automation (akm-improve) into the AKM stash. Idempotent —
 * an existing file is left untouched so operator edits survive re-install and
 * upgrade. A no-op (with a warning) when the automation is missing from the
 * registry.
 */
export function seedDefaultAutomation(state: ControlPlaneState): void {
	const tasksDir = join(state.stashDir, 'tasks');
	mkdirSync(tasksDir, { recursive: true });
	const akmImproveDest = join(tasksDir, 'akm-improve.yml');
	if (existsSync(akmImproveDest)) return;
	const akmImproveTask = getRegistryAutomation('akm-improve');
	if (akmImproveTask) {
		writeFileSync(akmImproveDest, akmImproveTask);
		logger.info('seeded default automation', { name: 'akm-improve' });
	} else {
		logger.warn('default automation missing from registry; skipping seed', {
			name: 'akm-improve'
		});
	}
}

// ── Core Setup Orchestration ─────────────────────────────────────────────

export async function performSetup(
	input: SetupSpec,
	opts?: { state?: ControlPlaneState }
): Promise<SetupResult> {
	const validation = validateSetupSpec(input);
	if (!validation.valid) return { ok: false, error: validation.errors.join('; ') };

	const {
		llm,
		embedding,
		security,
		owner,
		connections,
		portalCredentials,
		addons,
		voiceProfile,
		ollamaProfile,
		imageTag,
		hostAkm,
		access
	} = input;
	const state = opts?.state ?? createState();

	// Acquire install lock to prevent two concurrent setup runs from racing on
	// the same config directory. The lock lives in dataDir so it is co-located
	// with runtime state and the same path startDeploy uses.
	const lockHandle: InstallLockHandle | null = acquireInstallLock(state.dataDir);
	if (lockHandle === null) {
		return {
			ok: false,
			error:
				"install_in_progress: Another install is in progress. Wait for it to finish (the lock clears itself automatically after 30 minutes). If you're sure nothing is running, run 'openpalm unlock' to clear a stale lock."
		};
	}

	logger.info('performing setup', { connectionCount: connections.length });
	const updates = buildOwnerEnvFromSetup(owner);
	const providerKeys = buildAuthJsonFromSetup(connections);

	// Wrap all persistence work in try/finally so the lock is ALWAYS released.
	try {
		initializeStateSecrets(state);
		// Persist vault env files + OpenCode auth.json
		try {
			ensureHomeDirs();
			ensureSecrets(state);
			updateSecretsEnv(state, updates);
			persistPortalCredentials(state, portalCredentials);
			// PR #564 P1-1: only write the UI login password when the operator
			// actually supplied one. An unchanged rerun omits it — preserve the
			// existing secret rather than rotating it to a value the operator never
			// saw (which would lock them out). Fail closed if there is nothing to
			// preserve (a fresh install must supply a password).
			if (security.uiLoginPassword) {
				patchSecretsEnvFile(state.homeDir, { OP_UI_LOGIN_PASSWORD: security.uiLoginPassword });
			} else if (!readSecret(state.homeDir, 'op_ui_login_password')?.trim()) {
				throw new Error(
					'security.uiLoginPassword is required — no existing UI login password to preserve.'
				);
			}
			// Network access toggles. Absent `access` means "leave whatever is in
			// stack.env untouched": a rerun over a hand-tuned env, or over a
			// previous choice, never silently rewrites it unless the operator
			// actively set toggles this run.
			if (access) {
				const toggles = coerceAccessToggles(access);
				// Stored intent + the row it generates. Writing intent is what lets
				// every later read be a read instead of an inference from bind
				// addresses (access-toggles.ts ACCESS_INTENT_KEYS).
				const patches: Record<string, string> = {
					...resolveAccessIntentEnv(toggles),
					...resolveAccessEnv(toggles),
				};
				// Publishing the assistant API always turns auth on, with a key the
				// system GENERATES. The operator is never asked to invent one: the
				// human-facing credential is the UI login password in every
				// configuration, and this key is copy-pasted into another app.
				// Preserved across reruns — rotating it would break every client that
				// already holds it.
				if (
					requiresAssistantKey(toggles) &&
					!readSecret(state.homeDir, 'op_opencode_password')?.trim()
				) {
					patches.OP_OPENCODE_PASSWORD = randomHex(24);
				}
				patchSecretsEnvFile(state.homeDir, patches);
			}
			// Provider API keys land in OpenCode's auth.json (bind-mounted into
			// the assistant container) — never in stack.env.
			writeAuthJsonProviderKeys(state, providerKeys);
		} catch (err) {
			const message = errMessage(err);
			logger.error('failed to persist setup outputs', { error: message });
			return { ok: false, error: `Failed to persist setup outputs: ${message}` };
		}

		// Everything from here through the OP_SETUP_COMPLETE write is wrapped in a
		// single try/catch so that a disk-full or permission-denied mid-way returns a
		// clean error rather than leaving a broken half-installed ~/.openpalm/.
		try {
			// Reconcile the per-image versions on EVERY setup run. A non-empty
			// wizard value pins each platform service image to that exact tag —
			// kept verbatim, "latest" included, as an explicit opt-in.
			// state/stack.env is the SOLE pin location (never the legacy
			// — writeVersions()/writeManagedVersions() write there exclusively.
			//
			// A BLANK Advanced field defaults platform services to this host
			// release's immutable version tag, as a release-managed default rather
			// than a pin — see writeManagedVersions below. Product releases publish
			// host assets and all three platform images as one unit, so falling
			// back to moving `latest` would make two identical installs resolve
			// different runtimes.
			//
			// Voice is EXCLUDED from the pin: its tags are `latest-cpu` /
			// `vX.Y.Z-cu121` (GPU-variant suffixed), not platform semver, so a bare
			// PLATFORM_VERSION pin would resolve to a nonexistent
			// `openpalm/voice:0.13.0`; it also ships on its own, out-of-band release
			// cadence (publish-voice.yml), decoupled from platform releases entirely,
			// so there is no platform-coordinated tag to fall back to either. It
			// keeps tracking `latest` until explicitly pinned by the operator —
			// K2: that means an existing operator pin (set via the Updates tab, or a
			// prior setup run's own write to this same field — see below) must
			// SURVIVE a rerun, not get silently stomped back to `latest` every time
			// setup runs. Only a value still at the shared default is safe to
			// (re)default; anything else is a deliberate pin this run must preserve.
			const existingVoiceVersion = readStackEnv(state.homeDir).OP_VOICE_VERSION?.trim();
			const voiceVersion =
				existingVoiceVersion && existingVoiceVersion !== VERSION_DEFAULTS.OP_VOICE_VERSION
					? existingVoiceVersion
					: VERSION_DEFAULTS.OP_VOICE_VERSION;
			// Voice is "pinned" (an operator's deliberate choice, preserved above)
			// exactly when it has drifted from the shared default; otherwise it's
			// still tracking the default and counts as release-managed below.
			const voiceIsPinned = voiceVersion !== VERSION_DEFAULTS.OP_VOICE_VERSION;
			const trimmedTag = imageTag?.trim();
			// Split into what the OPERATOR chose (an explicit Advanced image tag, or
			// an existing voice pin preserved above) from what SETUP is filling in on
			// its own behalf (the coordinated platform default, or voice still on its
			// shared default). The former must go through writeVersions, which blanks
			// each key's managed marker so a later `openpalm update` never touches an
			// operator's deliberate pin. The latter must go through
			// writeManagedVersions instead, which stamps the marker to match — using
			// writeVersions for these too would blank every fresh install's markers on
			// setup's own writes, leaving `openpalm update` unable to ever advance the
			// very tags it just seeded.
			const pinnedUpdates: Record<string, string> = {};
			const managedUpdates: Record<string, string> = {};
			for (const key of SERVICE_VERSION_KEYS) {
				if (key === 'OP_VOICE_VERSION') {
					(voiceIsPinned ? pinnedUpdates : managedUpdates)[key] = voiceVersion;
					continue;
				}
				if (trimmedTag) pinnedUpdates[key] = trimmedTag;
				else managedUpdates[key] = PLATFORM_VERSION;
			}
			// NOTE: host-akm sharing no longer repoints the container's primary stash
			// (the old OP_AKM_STASH/OP_AKM_CONFIG split-brain). The personal ~/akm is
			// wired as a read-write SECONDARY source — see configureHostAkmSharing()
			// below (Phase 4) and the host-akm.compose.yml overlay.
			if (Object.keys(pinnedUpdates).length > 0) writeVersions(state, pinnedUpdates);
			if (Object.keys(managedUpdates).length > 0) writeManagedVersions(state, managedUpdates);

			// Write akm config with LLM and embedding settings from setup — atomic.
			persistAkmConfig(state, { llm, embedding });

			// Host AKM sharing. /host-stash is ALWAYS a secondary source in the akm
			// config — written once here, never removed. The compose bind-mount
			// controls what actually arrives at /host-stash: the real ~/akm when
			// OP_HOST_AKM_STASH is set (enabled), or the always-present empty dir
			// when it is unset (disabled). Profile import is best-effort on enable.
			addHostStashToOpenpalmConfig(state);
			if (hostAkm !== false) {
				const { profilesImported } = enableHostAkmSharing(state);
				logger.info('host akm sharing enabled during setup', { profilesImported });
			} else {
				disableHostAkmSharing(state);
			}

			// Enable/disable requested addons (portals like discord, slack, etc.).
			// PR #564 second retest R6: honor an EXPLICIT `false` as a disable — the
			// old `if (enabled)` skipped it, so `{discord:false}` left Discord enabled.
			// setAddonEnabled records explicit activation state and ensures portal
			// secret files (on enable) / clears the hardware-profile key (on disable).
			if (addons) {
				for (const [name, enabled] of Object.entries(addons)) {
					setAddonEnabled(state.homeDir, name, enabled === true, state);
				}
			}

			// The guardian service is profile-gated behind guardian-ingress addons,
			// so a bind address alone deploys no guardian at all. Publishing a front
			// door promises something reachable, so make it so.
			//
			// Shared with the admin PUT via lib's reconcileGuardianIngressAddons —
			// this logic used to live only here, so a guardian toggle flipped after
			// install published a host port onto a container that was never
			// deployed, and read back as ON while being silently inert.
			if (access) {
				reconcileGuardianIngressAddons(state, coerceAccessToggles(access), addons ?? {});
			}

			if (voiceProfile?.trim()) {
				setAddonProfileSelection(state.homeDir, 'voice', voiceProfile.trim());
			}

			if (ollamaProfile?.trim()) {
				setAddonProfileSelection(state.homeDir, 'ollama', ollamaProfile.trim());
			}

			ensureOpenCodeConfig();

			// Seed default automation into the AKM stash. Idempotent — existing files
			// are left alone so user edits survive re-install and upgrade.
			seedDefaultAutomation(state);

			// NOTE: OP_SETUP_COMPLETE is intentionally NOT written here. Writing it
			// before the Docker deploy succeeds would mark setup "complete" even
			// when containers fail to start, sending the user to a broken admin UI
			// with no path back to the wizard. The flag is now written by
			// setup-deploy.ts:startDeploy AFTER `compose up --wait` (§2.1's single
			// health gate) confirms every CORE service is healthy.
		} catch (err) {
			const message = errMessage(err);
			logger.error('failed to complete setup persistence', { error: message });
			return { ok: false, error: `Setup persistence failed: ${message}` };
		}

		logger.info('setup complete', { connectionCount: connections.length });
		return { ok: true };
	} finally {
		// Always release the install lock, whether setup succeeded or failed.
		releaseInstallLock(lockHandle);
	}
}
