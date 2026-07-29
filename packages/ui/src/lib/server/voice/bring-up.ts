/**
 * Voice addon bring-up engine — the Docker/compose infrastructure behind the
 * voice addon toggle (POST /api/host/addons(/voice) via
 * $lib/server/addon-helpers.performVoiceEngage). Kept out of the route so the
 * HTTP handler stays a thin request-validation + delegation layer (the
 * thin-route-over-service pattern used across the host-admin API).
 *
 * Responsibilities:
 *   - Docker image inspection + resolution (dockerImagePresent / resolveServiceImage)
 *   - UI-local host probes (TCP port, container health) — the rootless /
 *     nvidia-runtime host-fact probes live in lib (control-plane/voice-host-probes.ts)
 *     beside hardware-detect.ts, since they inspect the host, not addon/UI state.
 *   - Fallback-overlay SELECTION only: voice.compose.cdi.yml and
 *     voice.compose.rootless.yml ship as static files in the skeleton's
 *     managed system/stack/ tree (packages/skeleton/system/stack/) — nothing
 *     here generates compose YAML.
 *   - The in-memory background-job registry (activeJobs)
 *   - The engageVoiceAddon orchestration that the route delegates to; the
 *     actual compose-up + health-wait lifecycle (runBringUp) is a thin
 *     shim over `@openpalm/lib`'s single `applyStack` driver (plan 2.2) —
 *     this file keeps only job registry + progress-step rendering, plus the
 *     "warming" re-probe and voice-specific error-copy translation that
 *     applyStack's generic result doesn't carry.
 *
 * Everything here is server-only (uses node:child_process / node:net /
 * node:fs) and returns plain data — the route maps the results to HTTP
 * responses.
 */
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { getState } from '$lib/server/state.js';
import {
	annotateAddonProfileAvailability,
	addonProfileId,
	activateComposeCommand,
	activateStack,
	buildComposeOptions,
	detectRootlessDocker,
	dockerHasNvidiaRuntime,
	execFileNoThrow,
	getAddonProfiles,
	getAddonProfileAvailability,
	getAddonProfileSelection,
	listEnabledAddonIds,
	setAddonEnabled,
	setAddonProfileSelection,
	stackDirFor
} from '@openpalm/lib';
import type { AddonProfile, InstallLockHandle } from '@openpalm/lib';
import { translateDockerError } from '$lib/server/voice-errors.js';

export const VOICE_ADDON = 'voice';
// compose.yml advertises start_period: 180s. The health-wait must tolerate at
// least that long on a cold-disk first launch (model download + warm-up).
const VOICE_PROBE_TIMEOUT_MS = 180_000;
const PORT_PROBE_TIMEOUT_MS = 750;

// ── Background-pull job state ────────────────────────────────────────
// First-time image pulls can take many minutes on slow connections.
// Browser fetch timeouts (90–120s typical) and the route's 180s health
// poll both fire long before a 2–8 GB pull finishes — operators end up
// staring at a "network error" while the pull is still running. To
// decouple, when we detect an absent large-tag image we kick off the
// long work (the applyStack compose-up + health-wait) in the background, return 202
// immediately, and have the UI poll GET /api/host/addons for status.
type VoiceJobState = 'pulling' | 'starting' | 'healthy' | 'error';
export type VoiceJobStep = { step: string; ok: boolean; detail?: string };
export type VoiceActiveJob = {
	state: VoiceJobState;
	steps: VoiceJobStep[];
	error?: string;
	startedAt: number;
	finishedAt?: number;
	profile?: string;
};
const JOB_RETAIN_MS = 5 * 60_000;
const activeJobs = new Map<string, VoiceActiveJob>();

export function setJob(addon: string, patch: Partial<VoiceActiveJob>): VoiceActiveJob {
	const existing = activeJobs.get(addon);
	const next: VoiceActiveJob = existing
		? { ...existing, ...patch }
		: {
				state: 'pulling',
				steps: [],
				startedAt: Date.now(),
				...patch
			};
	activeJobs.set(addon, next);
	return next;
}

export function getActiveJob(addon: string): VoiceActiveJob | undefined {
	const job = activeJobs.get(addon);
	if (!job) return undefined;
	const age = Date.now() - (job.finishedAt ?? job.startedAt);
	if (age > JOB_RETAIN_MS) {
		activeJobs.delete(addon);
		return undefined;
	}
	return job;
}

/** Reset the in-memory job registry. Exposed for tests only. */
export function _resetJobs(): void {
	activeJobs.clear();
}

/**
 * Pick the best profile for this host. Prefers the first available GPU
 * profile (anything that isn't the canonical CPU profile) so operators with NVIDIA/AMD hardware
 * get the accelerated variant auto-selected. Falls back to the labelled
 * default, then first available, then first profile.
 */
export function resolveDefaultProfile(profiles: AddonProfile[]): string | null {
	if (profiles.length === 0) return null;
	const availableGpu = profiles.find(
		(p) => p.id !== addonProfileId(VOICE_ADDON, 'cpu') && p.available !== false
	);
	if (availableGpu) return availableGpu.id;
	const labelledDefault = profiles.find((p) => p.default);
	if (labelledDefault && labelledDefault.available !== false) return labelledDefault.id;
	const firstAvailable = profiles.find((p) => p.available !== false);
	if (firstAvailable) return firstAvailable.id;
	return profiles[0].id;
}

/**
 * The Capabilities-facing view of the voice addon: annotated hardware
 * profiles, the current selection (falling back to the host-appropriate
 * default), and the in-flight background job when one exists. Served by
 * GET /api/host/addons(/voice) so the Add-ons drawer can render the
 * hardware-profile picker and poll bring-up progress.
 */
export async function voiceAddonInfo(homeDir: string): Promise<{
	profiles: AddonProfile[];
	selectedProfile: string | null;
	activeJob?: VoiceActiveJob;
}> {
	const rawProfiles = getAddonProfiles(homeDir, VOICE_ADDON);
	const profiles = await annotateAddonProfileAvailability(rawProfiles);
	const selectedProfile =
		getAddonProfileSelection(homeDir, VOICE_ADDON) ?? resolveDefaultProfile(profiles);
	const activeJob = getActiveJob(VOICE_ADDON);
	return { profiles, selectedProfile, ...(activeJob ? { activeJob } : {}) };
}

// Preset values for the bundled openpalm/voice addon. The voice container
// exposes both endpoints on a single host:port and the UI server reaches
// it through the loopback binding in the voice addon's compose overlay.
// Host port is overridable via OP_VOICE_PORT_HOST in stack.env (defaults
// to 8880, matching the container's internal port).
export function voiceHostPort(): number {
	const raw = process.env.OP_VOICE_PORT_HOST?.trim();
	const n = raw ? Number(raw) : NaN;
	return Number.isFinite(n) && n > 0 ? n : 8880;
}

// ── Helpers: docker image inspect, port probe, container probe ─────

/**
 * True when the local docker daemon already has the named image cached.
 * `docker image inspect` exits 0 only when the image is present locally.
 */
async function dockerImagePresent(imageRef: string): Promise<boolean> {
	if (!imageRef) return true;
	const res = await execFileNoThrow('docker', ['image', 'inspect', imageRef], 5_000);
	return res.ok;
}

/**
 * Heuristic: image tags that include `-cu121` / `-rocm6` / `-cpu` are the
 * multi-GB voice images. Show the "this may take a few minutes" toast for
 * first pulls so the operator knows the upcoming compose-up isn't stuck.
 */
export function isLargeImageTag(imageRef: string): boolean {
	return /(-cu\d+|-rocm\d+|-cpu)(\s|$|@|\b)/i.test(imageRef);
}

function resolveProjectName(): string {
	return (
		process.env.OP_PROJECT_NAME?.trim() || process.env.COMPOSE_PROJECT_NAME?.trim() || 'openpalm'
	);
}

/**
 * Read the resolved image for a service from the merged compose config.
 * Best-effort — returns "" on any failure so callers can skip the pre-pull
 * check rather than blocking save.
 */
async function resolveServiceImage(composeFiles: string[], service: string): Promise<string> {
	const args = ['compose'];
	for (const f of composeFiles) args.push('-f', f);
	args.push('--project-name', resolveProjectName(), 'config', '--format', 'json');
	const res = await execFileNoThrow('docker', args, 15_000);
	if (!res.ok) return '';
	try {
		const parsed = JSON.parse(res.stdout) as { services?: Record<string, { image?: string }> };
		return parsed.services?.[service]?.image ?? '';
	} catch {
		return '';
	}
}

/**
 * Probe a TCP port on 127.0.0.1. Resolves true when the connect succeeds
 * within PORT_PROBE_TIMEOUT_MS — meaning something is already listening.
 */
function isPortListening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host: '127.0.0.1', port });
		let done = false;
		const finish = (listening: boolean): void => {
			if (done) return;
			done = true;
			try {
				socket.destroy();
			} catch {
				/* noop */
			}
			resolve(listening);
		};
		socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(false));
		socket.once('connect', () => finish(true));
		socket.once('error', () => finish(false));
	});
}

/**
 * True when a docker container whose name matches openpalm-voice* is
 * already running and presumably owns the host port. Used by the port
 * pre-flight to avoid false positives when our own voice container is
 * the listener.
 */
async function ourVoiceContainerRunning(): Promise<boolean> {
	const res = await execFileNoThrow(
		'docker',
		['ps', '--filter', 'name=openpalm-voice', '--format', '{{.Names}}'],
		5_000
	);
	if (!res.ok) return false;
	return res.stdout.trim().length > 0;
}

/**
 * Read the Docker healthcheck state of a container.
 * Returns "starting" while compose's start_period grace window is in
 * effect; "healthy" / "unhealthy" / "none" / "" otherwise.
 */
async function readContainerHealthStatus(containerNamePrefix: string): Promise<string> {
	const listRes = await execFileNoThrow(
		'docker',
		['ps', '--filter', `name=${containerNamePrefix}`, '--format', '{{.Names}}'],
		5_000
	);
	const name = listRes.stdout
		.split('\n')
		.map((s) => s.trim())
		.find(Boolean);
	if (!name) return '';
	const inspect = await execFileNoThrow(
		'docker',
		[
			'inspect',
			name,
			'--format',
			'{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
		],
		5_000
	);
	return inspect.stdout.trim();
}

// ── Host fallback overlays (CDI, rootless Docker) ─────────────────────
//
// voice.compose.cdi.yml / voice.compose.rootless.yml ship as STATIC files in
// the skeleton's managed system/stack/ tree (packages/skeleton/system/stack/)
// — applyHomeSeed materializes them into every OP_HOME on install/update, the
// same as core/services/portals.compose.yml. There is nothing to generate
// here; we only decide (via the lib host-fact probes) whether to include the
// already-present file in this one applyStack call's file list.

/** Path of the static CDI overlay, or null when the managed tree isn't seeded yet. */
function voiceCdiOverlayPath(homeDir: string): string | null {
	const overlayPath = join(stackDirFor(homeDir), 'voice.compose.cdi.yml');
	return existsSync(overlayPath) ? overlayPath : null;
}

/** Path of the static rootless overlay, or null when the managed tree isn't seeded yet. */
function voiceRootlessOverlayPath(homeDir: string): string | null {
	const overlayPath = join(stackDirFor(homeDir), 'voice.compose.rootless.yml');
	return existsSync(overlayPath) ? overlayPath : null;
}

// ── Bring-up lifecycle ───────────────────────────────────────────────

type BringUpInput = {
	state: ReturnType<typeof getState>;
	lock?: InstallLockHandle;
	services: string[];
	activeProfile: string | null;
	extraFiles: string[];
	availableProfiles: AddonProfile[];
	steps: VoiceJobStep[];
};

type BringUpOutcome = {
	composeOk: boolean;
	composeErr?: string;
	healthy: boolean;
	warming: boolean;
	steps: VoiceJobStep[];
};

/**
 * Stops services from OTHER profiles, then routes the actual compose-up +
 * health-wait through `@openpalm/lib`'s single {@link applyStack} driver
 * (plan 2.2) — this function no longer runs its own composeUp or /health
 * poll. `applyStack`'s health-wait reads the SAME docker HEALTHCHECK every
 * voice compose service already declares (`curl .../health` inside the
 * container, `start_period: 180s`), so it observes exactly what the removed
 * manual HTTP poll observed, just via `docker inspect` instead of a
 * host-side fetch loop.
 *
 * Returns the terminal state. Pushed `steps` get mutated in place so the
 * caller (sync or background) can read progress as it happens.
 */
async function runBringUp(input: BringUpInput): Promise<BringUpOutcome> {
	const { state, lock, services, activeProfile, extraFiles, availableProfiles, steps } = input;

	let composeOk: boolean;
	let composeErr: string | undefined;
	let healthy = false;
	try {
		// Profile switch: stop services from OTHER profiles so they release
		// their host port binding (all variants share 8880) before we bring
		// up the chosen one. composeStop, not down, keeps their images
		// cached for a future switch back.
		const otherProfileServices = availableProfiles
			.filter((p) => p.id !== activeProfile)
			.flatMap((p) => p.services)
			.filter((svc) => !services.includes(svc));
		if (otherProfileServices.length > 0) {
			try {
				await activateComposeCommand(state, ['stop', ...otherProfileServices], { lock });
			} catch (e) {
				console.warn('[voice] composeStop other profiles failed:', e);
			}
		}

		const baseOpts = buildComposeOptions(state);
		const result = await activateStack(
			state,
			{ kind: 'services', services },
			// 180s matches the voice compose services' own start_period, so a
			// cold-disk first launch (model download + warm-up) gets the same
			// grace window the removed manual poll used.
			{ healthTimeoutMs: VOICE_PROBE_TIMEOUT_MS },
			{
				lock,
				composeOptions: {
					files: [...baseOpts.files, ...extraFiles],
					envFiles: baseOpts.envFiles,
					profiles: activeProfile ? [activeProfile] : baseOpts.profiles
				}
			}
		);

		if (result.upFailed) {
			// Only an `up`-command failure carries raw stderr worth re-translating
			// through voice's own operator-facing hints (CPU-profile suggestion,
			// CDI/NVIDIA runtime copy, port-in-use) — applyStack's own `error` is
			// already mapDockerError-translated for the generic admin UI, which
			// doesn't know about voice profiles.
			composeOk = false;
			composeErr = translateDockerError(result.rawStderr || result.error || 'compose up failed');
		} else {
			// `up` succeeded; `result.ok` also folds in the post-up health wait.
			composeOk = true;
			healthy = result.ok;
		}
	} catch (e) {
		composeOk = false;
		composeErr = translateDockerError(e instanceof Error ? e.message : String(e));
	}
	steps.push({
		step: 'compose-up',
		ok: composeOk,
		...(composeErr ? { detail: composeErr.slice(0, 500) } : {})
	});

	if (!composeOk) {
		return { composeOk, composeErr, healthy: false, warming: false, steps };
	}

	// applyStack's health-wait already timed out above if `healthy` is false
	// here. Re-probe the container's OWN health status once more to tell a
	// still-cold-booting container ("starting") from a harder failure — the
	// same distinction the removed manual poll made, now sourced from Docker's
	// healthcheck state instead of a duplicate HTTP probe.
	let warming = false;
	if (!healthy) {
		try {
			const health = await readContainerHealthStatus('openpalm-voice');
			if (health === 'starting') warming = true;
		} catch {
			/* ignore */
		}
	}

	steps.push({
		step: 'healthy',
		ok: healthy || warming,
		...(healthy
			? {}
			: warming
				? { detail: 'still warming up — refresh in a moment' }
				: { detail: `did not become healthy within ${VOICE_PROBE_TIMEOUT_MS / 1000}s` })
	});

	return { composeOk, healthy, warming, steps };
}

type BringUpJobInput = Omit<BringUpInput, 'steps'> & { baseSteps: VoiceJobStep[] };

/**
 * Background variant: runs runBringUp and persists state transitions
 * into the activeJobs map. Returns nothing — the UI polls GET
 * /api/host/addons to observe completion.
 */
async function runBringUpJob(input: BringUpJobInput): Promise<void> {
	const steps = [...input.baseSteps];
	try {
		setJob(VOICE_ADDON, { state: 'starting', steps });
		const outcome = await runBringUp({ ...input, steps });
		if (!outcome.composeOk) {
			setJob(VOICE_ADDON, {
				state: 'error',
				steps: outcome.steps,
				error: `Voice addon failed to start: ${outcome.composeErr ?? 'unknown error'}`,
				finishedAt: Date.now()
			});
			return;
		}
		setJob(VOICE_ADDON, {
			state: outcome.healthy ? 'healthy' : outcome.warming ? 'starting' : 'error',
			steps: outcome.steps,
			...(outcome.healthy || outcome.warming
				? { error: undefined }
				: { error: 'Voice addon is starting but did not become healthy in time.' }),
			finishedAt: Date.now()
		});
	} catch (e) {
		setJob(VOICE_ADDON, {
			state: 'error',
			steps,
			error: e instanceof Error ? e.message : String(e),
			finishedAt: Date.now()
		});
	}
}

// ── Orchestration ────────────────────────────────────────────────────

/**
 * Result of engageVoiceAddon. The route maps each variant to an HTTP
 * response — the engine itself never touches Response objects.
 */
export type VoiceEngageResult =
	| { status: 'disengaged' }
	| { status: 'invalid_profile'; message: string }
	| { status: 'error'; wasAlreadyEnabled: boolean; steps: VoiceJobStep[]; error: string }
	| {
			status: 'background';
			wasAlreadyEnabled: boolean;
			steps: VoiceJobStep[];
			message: string;
			completion: Promise<void>;
	  }
	| {
			status: 'final';
			wasAlreadyEnabled: boolean;
			steps: VoiceJobStep[];
			healthy: boolean;
			warming: boolean;
	  };

/**
 * The full voice-addon bring-up lifecycle after request validation:
 * auto-stop when disengaging, else resolve profile → enable addon →
 * port pre-flight → image inspect → host fallback overlays → background
 * short-circuit or synchronous compose-up + health wait.
 */
export async function engageVoiceAddon(input: {
	state: ReturnType<typeof getState>;
	wantsVoiceAddon: boolean;
	requestedProfile: string;
	lock?: InstallLockHandle;
}): Promise<VoiceEngageResult> {
	const { state, lock, wantsVoiceAddon, requestedProfile } = input;

	// ── Auto-stop when neither side uses openpalm-voice ──────────────
	// We don't disable the addon (operator may toggle back quickly), but
	// we free the port + RAM by stopping the container. composeStop is a
	// no-op when nothing is running.
	if (!wantsVoiceAddon) {
		const enabledIds = listEnabledAddonIds(state.homeDir);
		if (enabledIds.includes(VOICE_ADDON)) {
			try {
				const voiceServiceNames = getAddonProfiles(state.homeDir, VOICE_ADDON).flatMap(
					(p) => p.services
				);
				const unique = Array.from(new Set(voiceServiceNames));
				if (unique.length > 0) {
					await activateComposeCommand(state, ['stop', ...unique], { lock });
				}
			} catch (e) {
				// Best-effort. The user moved away from openpalm-voice; we don't
				// want to block the save on a stop failure.
				console.warn('[voice] composeStop on disengage failed:', e);
			}
		}
		return { status: 'disengaged' };
	}

	// Resolve which canonical compose profile to bring up. Body
	// wins; falls back to whatever is already in stack.env; if neither is
	// set, picks the profile marked openpalm.profile.default in the
	// addon compose.yml (else the first one). Unknown profile ids are
	// rejected against the addon's declared profile catalog.
	const rawProfiles = getAddonProfiles(state.homeDir, VOICE_ADDON);
	const availableProfiles = await annotateAddonProfileAvailability(rawProfiles);
	let activeProfile: string | null = null;
	if (requestedProfile) {
		if (!availableProfiles.some((p) => p.id === requestedProfile)) {
			return {
				status: 'invalid_profile',
				message: `Unknown voice profile "${requestedProfile}". Available: ${availableProfiles.map((p) => p.id).join(', ') || '(none)'}`
			};
		}
		activeProfile = requestedProfile;
		setAddonProfileSelection(state.homeDir, VOICE_ADDON, activeProfile);
	} else {
		activeProfile =
			getAddonProfileSelection(state.homeDir, VOICE_ADDON) ??
			resolveDefaultProfile(availableProfiles);
	}

	const enabledIds = listEnabledAddonIds(state.homeDir);
	const wasAlreadyEnabled = enabledIds.includes(VOICE_ADDON);

	// Track each side-effect for the operator-facing steps in the Add-ons tab.
	const steps: VoiceJobStep[] = [];

	if (!wasAlreadyEnabled) {
		try {
			setAddonEnabled(state.homeDir, VOICE_ADDON, true, state);
			steps.push({ step: 'enable', ok: true });
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			steps.push({ step: 'enable', ok: false, detail });
			return {
				status: 'error',
				wasAlreadyEnabled,
				steps,
				error: `Could not enable voice addon: ${detail}`
			};
		}
	} else {
		steps.push({ step: 'enable', ok: true, detail: 'already enabled' });
	}

	// ── Pre-flight port collision check ──────────────────────────────
	// Save the operator from the half-recreate Docker leaves behind when
	// it tries to bind a host port that's already taken. We skip when our
	// own voice container is the listener (we'll replace it cleanly via
	// --force-recreate below). The vitest harness sets VITEST=1; under
	// tests this whole check is meaningless because the integration
	// surface is mocked, so we short-circuit.
	const hostPort = voiceHostPort();
	const inVitest = !!process.env.VITEST;
	const portTaken = inVitest ? false : await isPortListening(hostPort);
	if (portTaken) {
		const oursIsRunning = await ourVoiceContainerRunning();
		if (!oursIsRunning) {
			const msg = translateDockerError(
				`Bind for 127.0.0.1:${hostPort} failed: port is already allocated`
			);
			steps.push({ step: 'port-check', ok: false, detail: msg });
			return { status: 'error', wasAlreadyEnabled, steps, error: msg };
		}
		steps.push({ step: 'port-check', ok: true, detail: 'our container is the listener' });
	} else {
		steps.push({ step: 'port-check', ok: true });
	}

	// ── Pre-flight image inspect ─────────────────────────────────────
	// If the image is missing locally AND its tag is a known large one,
	// we'll fork the long work (the applyStack compose-up + healthcheck) into a
	// background job so the UI can return immediately and poll
	// GET /api/host/addons for progress.
	const profileServices = activeProfile
		? (availableProfiles.find((p) => p.id === activeProfile)?.services ?? [])
		: [];
	const services = profileServices.length > 0 ? profileServices : [VOICE_ADDON];

	const composeFilesBase = buildComposeOptions(state).files;
	const primaryService = services[0];
	let backgroundPull = false;
	if (primaryService && !inVitest) {
		const imageRef = await resolveServiceImage(composeFilesBase, primaryService);
		if (imageRef && isLargeImageTag(imageRef)) {
			const present = await dockerImagePresent(imageRef);
			if (!present) {
				backgroundPull = true;
				steps.push({
					step: 'pulling',
					ok: true,
					detail: 'first-time download — several minutes for several GB'
				});
			}
		}
	}

	// ── CDI fallback for canonical CUDA profile ─────────────────────
	// When the operator picks `cuda` but the host has only CDI (no
	// legacy nvidia runtime), include the static voice.compose.cdi.yml
	// overlay (ships in system/stack/, rewrites voice-cuda to use
	// deploy.resources.reservations.devices+driver:cdi). The canonical
	// compose stays the runtime-nvidia form (no manual setup case).
	// Overlay is applied only for this one applyStack call.
	//
	// Skipped on Windows: the operator must use Docker Desktop with WSL2
	// GPU integration there, and CDI specs live inside WSL2 — the Node
	// host can't read /etc/cdi/* and the probe would always fail.
	const extraFiles: string[] = [];
	const cdiFallbackSupported = process.platform !== 'win32';
	if (activeProfile === addonProfileId(VOICE_ADDON, 'cuda') && !inVitest && cdiFallbackSupported) {
		const cudaAvailability = await getAddonProfileAvailability({
			id: addonProfileId(VOICE_ADDON, 'cuda')
		});
		const runtimeMissing =
			cudaAvailability.available === false || !(await dockerHasNvidiaRuntime());
		const cdiSpecPresent = existsSync('/etc/cdi/nvidia.yaml');
		if (runtimeMissing && cdiSpecPresent) {
			const overlay = voiceCdiOverlayPath(state.homeDir);
			if (overlay) {
				extraFiles.push(overlay);
				steps.push({ step: 'cdi-fallback', ok: true, detail: 'using CDI device reservation' });
			}
		}
	}

	// ── Rootless Docker fallback ─────────────────────────────────────
	// On rootless Docker the compose-baked `user: ${OP_UID}:${OP_GID}`
	// directive resolves to a UID that the namespaced container can't use
	// to write the bind-mounted models directory. Include the static
	// voice.compose.rootless.yml overlay (ships in system/stack/) to drop
	// the directive; Docker then picks the in-namespace UID, which has the
	// right permission against the subuid-remapped bind mount.
	if (!inVitest) {
		try {
			const rootless = await detectRootlessDocker();
			if (rootless) {
				const overlay = voiceRootlessOverlayPath(state.homeDir);
				if (overlay) {
					extraFiles.push(overlay);
					steps.push({
						step: 'rootless-fallback',
						ok: true,
						detail: 'dropping user: directive for rootless Docker'
					});
				}
			}
		} catch (e) {
			// Detection failures fall through to the un-overlayed path. The
			// operator can still complete the save; if they hit a permission
			// error inside the container, the existing translateDockerError
			// copy points them at the underlying cause.
			console.warn('[voice] rootless detection failed:', e);
		}
	}

	// ── Background-pull short-circuit ────────────────────────────────
	// When the image is missing AND large, fork the rest of the work
	// (composeStop, then applyStack's compose-up + health-wait) into a job that updates the
	// module-level activeJobs map. Return so the route replies 202
	// immediately and the browser/SvelteKit fetch doesn't time out during
	// the multi-minute pull. UI polls GET /api/host/addons for the activeJob.
	if (backgroundPull) {
		setJob(VOICE_ADDON, {
			state: 'pulling',
			steps: [...steps],
			startedAt: Date.now(),
			profile: activeProfile ?? undefined,
			finishedAt: undefined,
			error: undefined
		});
		const completion = runBringUpJob({
			state,
			lock,
			services,
			activeProfile,
			extraFiles,
			availableProfiles,
			baseSteps: [...steps]
		});
		return {
			status: 'background',
			wasAlreadyEnabled,
			steps,
			message:
				'Voice image is downloading in the background (~2–8 GB). ' +
				'Poll GET /api/host/addons for progress; UI auto-refreshes.',
			completion
		};
	}

	// ── Synchronous path ─────────────────────────────────────────────
	// The image is already present (or we couldn't tell). Run the
	// compose-up + health poll inline so the caller gets the terminal
	// state in one round trip.
	const outcome = await runBringUp({
		state,
		lock,
		services,
		activeProfile,
		extraFiles,
		availableProfiles,
		steps
	});

	if (!outcome.composeOk) {
		return {
			status: 'error',
			wasAlreadyEnabled,
			steps: outcome.steps,
			error: `Voice addon failed to start: ${outcome.composeErr ?? 'unknown error'}`
		};
	}

	return {
		status: 'final',
		wasAlreadyEnabled,
		steps: outcome.steps,
		healthy: outcome.healthy,
		warming: outcome.warming
	};
}
