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
import {
	coerceAccessToggles,
	resolveAccessEnv,
	resolveAccessIntentEnv,
	type AccessToggles
} from './access-toggles.js';
import { computeGuardianIngressRequired } from './remote-providers.js';
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
	/** Share the personal ~/akm stash. OPT-IN: absent means off (C14). */
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
 * Typed shape of the assistant's akm config.json (akm >= 0.9.0 schema). This
 * replaces the nested `as Record<string, unknown>` casts that used to
 * hand-manipulate the JSON in performSetup. Every field is optional because we
 * merge over whatever the operator (or a prior run) already wrote —
 * extra/unknown keys are preserved verbatim via the index signature.
 */
export type AkmLlmEngine = {
	kind: 'llm';
	endpoint: string;
	model: string;
	provider?: string;
	[key: string]: unknown;
};

export type AkmEmbeddingConfig = {
	endpoint: string;
	model: string;
	provider: string;
	dimension: number;
	[key: string]: unknown;
};

export type AkmBundleEntry = {
	path?: string;
	writable?: boolean;
	[key: string]: unknown;
};

export type AkmConfig = {
	configVersion?: string;
	engines?: Record<string, Record<string, unknown>>;
	defaults?: { engine?: string; llmEngine?: string; improveStrategy?: string; [key: string]: unknown };
	embedding?: AkmEmbeddingConfig;
	bundles?: Record<string, AkmBundleEntry>;
	defaultBundle?: string;
	[key: string]: unknown;
};

/** The bundle id OpenPalm uses for the assistant's primary /stash bundle. */
export const PRIMARY_BUNDLE_ID = 'openpalm';

/**
 * The bundle id for the release-shipped skills at /system-stash
 * (OP_HOME/system/skills, mounted `:ro` — core.compose.yml).
 *
 * `writable: false` is routing, not a boundary: it stops akm from ever picking
 * this bundle as the target of an untargeted write. The `:ro` mount is what
 * actually makes it read-only. Never the default bundle and never the default
 * write target — the assistant's own writes belong in /stash, which is the one
 * tree a backup captures as user data.
 */
export const SYSTEM_BUNDLE_ID = 'openpalm-system';

/** The engine name OpenPalm writes for the setup wizard's LLM selection. */
export const DEFAULT_LLM_ENGINE_NAME = 'default';

/**
 * akm 0.8-era config keys that the 0.9.0 schema hard-rejects at load time.
 * A config still carrying any of them fails to load entirely, so every
 * OpenPalm write strips them (I-3: the assistant's akm config must always be
 * loadable by the pinned akm-cli without a migration shim).
 */
export const RETIRED_AKM_CONFIG_KEYS = [
	'stashDir',
	'sources',
	'installed',
	'wikiName',
	'profiles',
	'llm',
	'agent',
	'features',
	'stashes'
] as const;

export function stripRetiredAkmKeys(config: Record<string, unknown>): void {
	for (const key of RETIRED_AKM_CONFIG_KEYS) delete config[key];
	if (config.defaults && typeof config.defaults === 'object') {
		delete (config.defaults as Record<string, unknown>).llm;
		delete (config.defaults as Record<string, unknown>).agent;
		delete (config.defaults as Record<string, unknown>).improve;
	}
}

/**
 * Merge the setup wizard's LLM + embedding selections into the assistant's
 * akm config.json (atomic write). Existing operator keys — sibling engines,
 * `bundles`, custom fields — are preserved. No-op when neither llm nor
 * embedding is supplied.
 *
 * Writes the CANONICAL akm 0.9.0 shape: `engines.default` (kind "llm") +
 * `defaults.llmEngine`, with `configVersion` pinned to "0.9.0" and the
 * primary bundle pinned to /stash via `bundles` + `defaultBundle`. The
 * retired 0.8 keys (`profiles`, `defaults.llm`, `stashDir`, `sources`, …) are
 * hard-rejected by akm 0.9.0's config schema, so they are stripped on every
 * write — akm no longer ships a load-time migration shim.
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
	stripRetiredAkmKeys(updated);
	updated.configVersion = '0.9.0';

	if (llm) {
		const engines = updated.engines ?? {};
		engines[DEFAULT_LLM_ENGINE_NAME] = {
			...(engines[DEFAULT_LLM_ENGINE_NAME] ?? {}),
			kind: 'llm',
			endpoint: buildAkmEndpoint(llm.provider, llm.baseUrl, '/chat/completions'),
			model: llm.model,
			provider: llm.provider
		};
		updated.engines = engines;
		const defaults = updated.defaults ?? {};
		if (typeof defaults.llmEngine !== 'string') defaults.llmEngine = DEFAULT_LLM_ENGINE_NAME;
		updated.defaults = defaults;
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

	// The assistant's primary bundle is ALWAYS /stash (the bind mount), and the
	// release-shipped skills are ALWAYS a read-only secondary at /system-stash.
	// Pin both in config so they are explicit and operator-edits can't repoint
	// them; the UI does not expose bundle paths. (The host task-runner still
	// uses its own AKM_BUNDLE_DIR env, which takes precedence over the
	// configured bundle.)
	const bundles = updated.bundles ?? {};
	bundles[PRIMARY_BUNDLE_ID] = {
		...(bundles[PRIMARY_BUNDLE_ID] ?? {}),
		path: '/stash',
		writable: true
	};
	bundles[SYSTEM_BUNDLE_ID] = {
		...(bundles[SYSTEM_BUNDLE_ID] ?? {}),
		path: '/system-stash',
		writable: false,
		enabled: true
	};
	updated.bundles = bundles;
	if (typeof updated.defaultBundle !== 'string') updated.defaultBundle = PRIMARY_BUNDLE_ID;
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
				// The `remote` addon can require GUARDIAN_DIRECT_INGRESS on its own,
				// without guardianNetwork being set — it tunnels to the guardian over
				// portal_net rather than through the LAN bind. Resolving the row
				// WITHOUT that input would recompute ingress from guardianNetwork
				// alone and silently switch off the listener a live guardian-targeting
				// tunnel depends on, breaking remote access until the next
				// applyAccessToggles happened to run. A setup rerun changes access
				// toggles, never the remote addon's own config, so current on-disk
				// state is the right source — read through the registry's single
				// ingress writer (remote-providers.ts), shared with access-apply.ts
				// and applyRemoteAccess so the call sites cannot drift.
				const guardianIngressRequired = computeGuardianIngressRequired(
					readStackEnv(state.homeDir)
				);
				// Stored intent + the row it generates. Writing intent is what lets
				// every later read be a read instead of an inference from bind
				// addresses (access-toggles.ts ACCESS_INTENT_KEYS).
				const patches: Record<string, string> = {
					...resolveAccessIntentEnv(toggles),
					...resolveAccessEnv(toggles, { guardianIngressRequired }),
				};
				// OpenCode's key is NOT seeded here. `ensureSecrets` above already
				// does it unconditionally (secrets.ts), which is what makes OpenCode
				// authenticated by default on every install.
				//
				// A branch here used to re-seed when the stored value was blank after
				// trimming. Given ensureSecrets ran first, the only state that could
				// still reach it was a file an operator had deliberately emptied to
				// run OpenCode without auth — so an unrelated setup rerun silently
				// regenerated a password, re-enabled auth on the next deploy, and
				// stranded whatever direct clients they had configured. The branch
				// could only ever fire in the one case where it was wrong.
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
			// when it is unset (disabled). The shared DIRECTORY is all of it — the
			// host's own akm config and CLI are never read (see host-akm-sharing).
			// C14: OPT-IN. Only an explicit `true` enables it. This used to be
			// `hostAkm !== false`, so an omitted field — every headless/API caller,
			// and the wizard itself, which sends the key only when the box is
			// ticked — turned on an rw bind of a directory OUTSIDE OP_HOME.
			addHostStashToOpenpalmConfig(state);
			if (hostAkm === true) {
				enableHostAkmSharing(state);
				logger.info('host akm sharing enabled during setup');
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

			// No addon reconciliation for the guardian toggles: a guardian toggle is
			// itself a guardianRequired reason (guardian-required.ts), so the access
			// row written above activates the bare `guardian` compose profile and
			// the wizard's whole-stack deploy brings the guardian up directly. The
			// auto-enable that used to live here flipped integrations (`chat`/`api`)
			// the operator never asked for, just to make a port publish real.

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
