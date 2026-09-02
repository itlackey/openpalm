/**
 * Version variable management for the OpenPalm control plane (§4.2, §5).
 *
 * SERVICE versions (`OP_*_VERSION`) are Docker image tags. They take an exact
 * tag or an explicit moving "latest" / "next" ref. They are never semver
 * ranges. Platform images default to the exact host release version.
 *
 * Tool package versions are managed via per-container package.json files at
 * OP_HOME/data/<container>/tools/package.json. Edit those files to pin or
 * update individual tool versions.
 *
 * Compose reads every SERVICE_VERSION_KEY directly via
 * `${OP_*_VERSION:-latest}` — there is no cascade fallback to a single platform
 * tag anymore. Each image rides its own var.
 *
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFileAtomic } from './fs-atomic.js';
import { parseEnvFile, mergeEnvContent, removeEnvKey } from './env.js';
import { HOME_SCHEMA_VERSION, readHomeSchemaVersion, stackEnvFile } from './home.js';
import { readSkeletonVersion } from './ui-assets.js';
import type { ControlPlaneState } from './types.js';
import { compareComparableVersions, isComparableSemver, normalizeVersion, PLATFORM_VERSION } from './versioning.js';

/** Docker image tags — one per deployable OpenPalm image. */
export const SERVICE_VERSION_KEYS = [
	'OP_ASSISTANT_VERSION',
	'OP_GUARDIAN_VERSION',
	'OP_PORTAL_VERSION',
	'OP_VOICE_VERSION'
] as const;

export type VersionKey = (typeof SERVICE_VERSION_KEYS)[number];

const VERSION_KEY_SET: ReadonlySet<string> = new Set(SERVICE_VERSION_KEYS);
export const MANAGED_VERSION_MARKERS: Record<VersionKey, string> = {
	OP_ASSISTANT_VERSION: 'OP_MANAGED_ASSISTANT_VERSION',
	OP_GUARDIAN_VERSION: 'OP_MANAGED_GUARDIAN_VERSION',
	OP_PORTAL_VERSION: 'OP_MANAGED_PORTAL_VERSION',
	OP_VOICE_VERSION: 'OP_MANAGED_VOICE_VERSION'
};

/** Default values seeded into a fresh stack.env (and returned for unset keys). */
export const VERSION_DEFAULTS: Record<VersionKey, string> = {
	OP_ASSISTANT_VERSION: PLATFORM_VERSION,
	OP_GUARDIAN_VERSION: PLATFORM_VERSION,
	OP_PORTAL_VERSION: PLATFORM_VERSION,
	OP_VOICE_VERSION: 'latest'
};

export function isVersionKey(key: string): key is VersionKey {
	return VERSION_KEY_SET.has(key);
}

/**
 * Tool-version keys retired when tool management moved to a per-container
 * `package.json` + `bun update` (b9478492, 2026-06-22).
 *
 * Nothing has written or read them since — not the images, not compose, not
 * this package — but every stack.env written before that commit still carries
 * them, and a stale row that LOOKS like configuration is worse than no row:
 * `OP_TOOL_AKM_VERSION=0.8.14` sitting beside the live `OP_*_VERSION` image
 * tags reads as the knob that pins the assistant's akm, so an operator
 * debugging a version skew edits it and nothing happens. Swept on the same
 * lifecycle pass that seeds the real version keys.
 */
export const RETIRED_TOOL_VERSION_KEYS = [
	'OP_TOOL_AKM_VERSION',
	'OP_TOOL_CLAUDE_CODE_VERSION',
	'OP_TOOL_CODEX_VERSION',
	'OP_TOOL_OPENCODE_VERSION',
	// The one that proved the docblock above literally true. The pre-0.13
	// release model WROTE this key; 554b79bc removed the writer and left the
	// value behind on every upgraded home. The guardian entrypoint honoured it,
	// discarding its correct image-baked package to install that old version
	// from npm on every boot — which predated 0.13.0's always-on OpenCode auth,
	// so the guardian 401'd, disabled its own proxy, answered /health/ready
	// with 503, failed its healthcheck, and took every stack update down with
	// it for months. The override no longer exists in the entrypoint; this
	// sweep is what removes the stale row that was driving it.
	'OP_GUARDIAN_NPM_VERSION',
	'OP_GUARDIAN_PACKAGE',
	'OP_GUARDIAN_ENTRY',
	'OP_GUARDIAN_NPMRC',
	'OP_GUARDIAN_NPMRC_FILE'
] as const;

// ── Version-skew guard (#636) ────────────────────────────────────────────────
//
// An OP_HOME is written by whichever app last ran install/update against it —
// `.skeleton-version` (ui-assets.ts) and `state/schema-version` (home.ts) both
// record that. Nothing used to compare those stamps against the CODE now
// running before writing to the home, so an older app (e.g. a desktop build
// stuck mid-self-update, #635) pointed at a home a newer app had already
// upgraded would silently downgrade it: `advanceManagedImageVersions`
// defaults its target to THIS build's `PLATFORM_VERSION`, and `applyHomeSeed`
// unconditionally overwrites `system/` and re-stamps `.skeleton-version` from
// THIS build's skeleton — both moving a newer home backwards with no operator
// confirmation.
//
// This is that comparison, done once. `newer` is true when either stamp says
// the home was written by a build ahead of this one; every caller that would
// mutate managed files, version pins, or the version stamps themselves must
// check it FIRST and refuse before touching anything. A missing or
// non-semver `.skeleton-version` (fresh install, a pre-stamp home) never
// trips it — `isComparableSemver` guards that — and neither does an equal or
// older home, which is the normal upgrade direction and must stay unguarded.

export type HomeVersionSkew = {
	/** True when the home was written by a build newer than the one running now. */
	newer: boolean;
	/** `.skeleton-version` stamped into the home, or null when absent/unparseable. */
	homeSkeletonVersion: string | null;
	/** This build's platform version (bare semver). */
	runningPlatformVersion: string;
	/** Recorded OP_HOME layout schema version (0 when unrecorded). */
	homeSchemaVersion: number;
	/** This build's OP_HOME layout schema version. */
	runningSchemaVersion: number;
};

/** Compare the home's recorded version stamps against the code running now. */
export function detectHomeVersionSkew(state: ControlPlaneState): HomeVersionSkew {
	const homeSkeletonVersion = readSkeletonVersion(state.homeDir);
	const homeSchemaVersion = readHomeSchemaVersion(state.homeDir);
	const skeletonNewer =
		isComparableSemver(homeSkeletonVersion) &&
		compareComparableVersions(homeSkeletonVersion as string, PLATFORM_VERSION) > 0;
	const schemaNewer = homeSchemaVersion > HOME_SCHEMA_VERSION;
	return {
		newer: skeletonNewer || schemaNewer,
		homeSkeletonVersion,
		runningPlatformVersion: PLATFORM_VERSION,
		homeSchemaVersion,
		runningSchemaVersion: HOME_SCHEMA_VERSION
	};
}

/**
 * Refuse to continue when `state.homeDir` was written by a newer OpenPalm than
 * the one running now. Call this BEFORE any managed-file write, version-pin
 * advance, or version-stamp write — see the module docblock above.
 */
export function assertHomeNotNewerThanApp(state: ControlPlaneState): void {
	const skew = detectHomeVersionSkew(state);
	if (!skew.newer) return;
	const homeLabel = skew.homeSkeletonVersion ?? `schema ${skew.homeSchemaVersion}`;
	throw new Error(
		`OP_HOME (${state.homeDir}) was set up by OpenPalm ${homeLabel}, but this app is ${skew.runningPlatformVersion}. ` +
			'Refusing to overwrite managed files, advance image versions, or downgrade this home. ' +
			`Update this app to ${homeLabel} or later, then try again.`
	);
}

// ── Version configuration ────────────────────────────────────────────────────

/**
 * Read configured image tags from app-owned state. Legacy stack.env version
 * values represented the previously applied release on older installs, not a
 * deliberate pin, so treating them as pins would freeze updates.
 */
export function readVersions(state: ControlPlaneState): Record<string, string> {
	const fromState = parseEnvFile(stackEnvFile(state.homeDir));
	const out: Record<string, string> = {};
	for (const key of SERVICE_VERSION_KEYS) {
		out[key] = fromState[key] ?? VERSION_DEFAULTS[key];
	}
	return out;
}

/** Ensure every image has an explicit state value that overrides legacy env files. */
export function ensureVersionDefaults(state: ControlPlaneState): void {
	const path = stackEnvFile(state.homeDir);
	const current = existsSync(path) ? parseEnvFile(path) : {};
	const missing: Record<string, string> = {};
	for (const key of SERVICE_VERSION_KEYS) {
		if (current[key] === undefined) {
			missing[key] = VERSION_DEFAULTS[key];
			missing[MANAGED_VERSION_MARKERS[key]] = VERSION_DEFAULTS[key];
		}
	}
	writeVersionState(state, missing);
	stripRetiredToolVersions(state);
}

/** Drop {@link RETIRED_TOOL_VERSION_KEYS} from `state/stack.env`. No-op once clean. */
export function stripRetiredToolVersions(state: ControlPlaneState): boolean {
	const path = stackEnvFile(state.homeDir);
	if (!existsSync(path)) return false;
	const content = readFileSync(path, 'utf-8');
	const parsed = parseEnvFile(path);
	const retired = RETIRED_TOOL_VERSION_KEYS.filter((key) => Object.hasOwn(parsed, key));
	if (retired.length === 0) return false;
	let next = content;
	for (const key of retired) next = removeEnvKey(next, key);
	if (next === content) return false;
	writeFileAtomic(path, next, 0o600);
	return true;
}

/** Advance release-managed exact pins while preserving explicit moving or custom pins. */
export function advanceManagedImageVersions(
	state: ControlPlaneState,
	previousPlatformVersion: string | null,
	targetPlatformVersion = PLATFORM_VERSION
): void {
	const current = parseEnvFile(stackEnvFile(state.homeDir));
	const previous = normalizeVersion(previousPlatformVersion);
	const updates: Record<string, string> = {};
	for (const key of SERVICE_VERSION_KEYS) {
		const value = current[key]?.trim() ?? '';
		const markerKey = MANAGED_VERSION_MARKERS[key];
		const managedValue = current[markerKey]?.trim() ?? '';
		const legacyManaged = current[markerKey] === undefined && key !== 'OP_VOICE_VERSION' && previous && normalizeVersion(value) === previous;
		if (value.startsWith('rollback-')) {
			const target = key === 'OP_VOICE_VERSION' ? VERSION_DEFAULTS.OP_VOICE_VERSION : targetPlatformVersion;
			updates[key] = target;
			updates[markerKey] = target;
		} else if ((managedValue && value === managedValue) || legacyManaged) {
			// Voice tags are variant-suffixed (latest-cpu, vX.Y.Z-cu121), not
			// platform semver, and publish-voice.yml never publishes a bare
			// platform-version tag — same reason the rollback arm above excludes
			// it. Advancing voice to targetPlatformVersion here would point it at
			// an image that was never published, and because this arm also
			// re-stamps the marker to match, the bad value would be sticky.
			const target = key === 'OP_VOICE_VERSION' ? VERSION_DEFAULTS.OP_VOICE_VERSION : targetPlatformVersion;
			updates[key] = target;
			updates[markerKey] = target;
		}
	}
	writeVersionState(state, updates);
}

/**
 * Write validated version tags to the state file (atomically: temp + rename).
 * Only SERVICE_VERSION_KEYS are accepted, so a typo or hostile caller can't smuggle
 * arbitrary env into the stack config. mergeEnvContent preserves any existing state
 * keys/comments. Supplied values, including `latest` and `next`, are persisted
 * honestly as the desired Compose configuration.
 *
 * This is the OPERATOR-PIN API: it blanks each key's OP_MANAGED_*_VERSION
 * marker, which tells advanceManagedImageVersions the value is a deliberate
 * choice that must never be auto-advanced. Only a genuine operator choice
 * (the Updates tab PATCH, or a wizard's explicit Advanced image-tag field)
 * should call this. A release-managed DEFAULT that setup fills in on the
 * operator's behalf must use writeManagedVersions below instead — blanking
 * its marker here would make it indistinguishable from a real pin and freeze
 * it on the install-time tag forever.
 */
export function writeVersions(state: ControlPlaneState, updates: Record<string, string>): void {
	writeVersionEntries(state, updates, () => '');
}

/**
 * Same validation/persistence as writeVersions, but for a value setup chose
 * as a release-managed DEFAULT, not something the operator asked for: the
 * marker is stamped to match the value (instead of blanked) so a later
 * advanceManagedImageVersions still recognizes it as managed and advances it
 * on the next release, exactly like the markers generateFallbackSystemEnv
 * seeds into a brand-new stack.env.
 */
export function writeManagedVersions(state: ControlPlaneState, updates: Record<string, string>): void {
	writeVersionEntries(state, updates, (value) => value);
}

/**
 * The voice services append the accelerator variant themselves —
 * `voice:${OP_VOICE_VERSION}-cpu`, `-cu121`, `-rocm6` — so OP_VOICE_VERSION
 * holds the BASE tag only.
 *
 * Nothing used to enforce that. An operator who read `openpalm/voice:latest-cpu`
 * off their running container and pasted it into the Updates tab's "Voice
 * image" field got `voice:latest-cpu-cpu`, an image that cannot exist. Every
 * later update then failed on an unresolvable reference, and nothing connected
 * that failure back to the field that caused it.
 */
const VOICE_VARIANT_SUFFIX_RE = /-(?:cpu|cu\d+|rocm\d+)$/i;

function writeVersionEntries(
	state: ControlPlaneState,
	updates: Record<string, string>,
	markerValue: (value: string) => string
): void {
	const accepted: Record<string, string> = {};
	for (const [key, value] of Object.entries(updates)) {
		if (!isVersionKey(key)) {
			throw new Error(`Refusing to write unknown version key: ${key}`);
		}
		const trimmed = (value ?? '').trim();
		if (key === 'OP_VOICE_VERSION' && VOICE_VARIANT_SUFFIX_RE.test(trimmed)) {
			throw new Error(
				`OP_VOICE_VERSION is the base image tag; Compose appends the accelerator suffix itself. Use "${trimmed.replace(VOICE_VARIANT_SUFFIX_RE, '')}" instead of "${trimmed}", or the image resolves to a tag that does not exist.`
			);
		}
		accepted[key] = trimmed;
		accepted[MANAGED_VERSION_MARKERS[key]] = markerValue(trimmed);
	}
	writeVersionState(state, accepted);
}

function writeVersionState(state: ControlPlaneState, updates: Record<string, string>): void {
	if (Object.keys(updates).length === 0) return;
	const path = stackEnvFile(state.homeDir);
	mkdirSync(`${state.homeDir}/state`, { recursive: true, mode: 0o700 });
	const current = existsSync(path) ? readFileSync(path, 'utf-8') : '';
	writeFileAtomic(path, mergeEnvContent(current, updates), 0o600);
}
