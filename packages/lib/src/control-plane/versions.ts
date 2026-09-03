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
 * Images the operator has pinned: `OP_PINNED_IMAGES=assistant,guardian`.
 * `openpalm update` deploys the release to every image EXCEPT these.
 *
 * This replaces the OP_MANAGED_*_VERSION markers (#679), which stored the same
 * one bit per image as a RELATIONSHIP between two version strings — equal meant
 * managed, blank meant pinned, and unequal meant nothing anyone wrote on
 * purpose, which silently froze a live stack on 0.13.1 while every `openpalm
 * update` reported success. A pin is one bit, so it is stored as one bit, in
 * one key, naming the images it applies to. There is no state it can be in that
 * does not read as exactly what it means.
 */
export const PINNED_IMAGES_KEY = 'OP_PINNED_IMAGES';

/** `OP_ASSISTANT_VERSION` <-> `assistant`. The list names services, not env keys. */
export function versionKeyToService(key: VersionKey): string {
	return key.slice('OP_'.length).replace('_VERSION', '').toLowerCase();
}

function serviceToVersionKey(service: string): VersionKey | null {
	const key = `OP_${service.trim().toUpperCase()}_VERSION`;
	return isVersionKey(key) ? key : null;
}

/** Parse OP_PINNED_IMAGES. Unknown names are ignored, not fatal. */
export function readPinnedImages(state: ControlPlaneState): Set<VersionKey> {
	const raw = parseEnvFile(stackEnvFile(state.homeDir))[PINNED_IMAGES_KEY] ?? '';
	const pinned = new Set<VersionKey>();
	for (const name of raw.split(',')) {
		const key = serviceToVersionKey(name);
		if (key) pinned.add(key);
	}
	return pinned;
}

/** Replace the pin list wholesale — the operator's checkbox state IS the list. */
export function writePinnedImages(state: ControlPlaneState, keys: Iterable<VersionKey>): void {
	const services = SERVICE_VERSION_KEYS.filter((key) => new Set(keys).has(key)).map(versionKeyToService);
	writeVersionState(state, { [PINNED_IMAGES_KEY]: services.join(',') });
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
export const RETIRED_STACK_ENV_KEYS = [
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
	'OP_GUARDIAN_NPMRC_FILE',
	// The managed-version markers (#679). Four shadow keys that encoded, by
	// their relationship to the real OP_*_VERSION rows, whether an update was
	// allowed to advance each image. Equal meant "release-managed", blank meant
	// "operator pin", and a third state nobody wrote deliberately — present but
	// DIFFERENT — silently froze the stack: `openpalm update` reported success
	// on every release while never moving the images again. That is what
	// happened on a live 0.13.1 -> 0.13.3 upgrade. Deleted rather than guarded:
	// an update now deploys this release's images, full stop.
	'OP_MANAGED_ASSISTANT_VERSION',
	'OP_MANAGED_GUARDIAN_VERSION',
	'OP_MANAGED_PORTAL_VERSION',
	'OP_MANAGED_VOICE_VERSION'
] as const;

// ── Version-skew guard (#636) ────────────────────────────────────────────────
//
// An OP_HOME is written by whichever app last ran install/update against it —
// `.skeleton-version` (ui-assets.ts) and `state/schema-version` (home.ts) both
// record that. Nothing used to compare those stamps against the CODE now
// running before writing to the home, so an older app (e.g. a desktop build
// stuck mid-self-update, #635) pointed at a home a newer app had already
// upgraded would silently downgrade it: `setPlatformImageVersions` writes
// THIS build's `PLATFORM_VERSION`, and `applyHomeSeed`
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

// ── CLI-vs-target version-skew guard (#662) ─────────────────────────────────
//
// #636 (above) stops an OLDER app from silently rewriting a NEWER home. #662
// is the same hazard from the other direction: `openpalm update` deploys
// image tags for `targetVersion` (THIS build's `PLATFORM_VERSION` — see
// `setPlatformImageVersions`), but
// nothing ever compared that target against the CLI binary actually doing the
// deploying. A CLI whose own package version trails the release it is about
// to pin the stack to finishes `update` having created exactly the stale
// control-plane / current-home pair #636 guards against on the NEXT run — an
// old CLI now "successfully" managing a newer stack. `openpalm self-update`
// is the fix; this only needs to catch the case and say so before deploying
// anything, per #662's own "minimum viable" option (not a self-update/re-exec
// redesign).
//
// The CLI's OWN version and the target are supplied by the caller (`update.ts`
// owns the CLI package.json read and the `--allow-version-skew` override;
// this package only owns the comparison), and only a genuinely OLDER,
// comparable CLI trips it — an equal or newer CLI is the normal, unguarded
// upgrade direction, and a non-semver value (a dev build) never trips it.

export type CliVersionSkew = {
	/** True when `cliVersion` is older than `targetVersion` — an old CLI about to deploy a newer stack. */
	older: boolean;
	cliVersion: string;
	targetVersion: string;
};

/** Compare the CLI's own version against the release version `openpalm update` is about to deploy. */
export function detectCliVersionSkew(cliVersion: string, targetVersion: string = PLATFORM_VERSION): CliVersionSkew {
	const older =
		isComparableSemver(cliVersion) &&
		isComparableSemver(targetVersion) &&
		compareComparableVersions(cliVersion, targetVersion) < 0;
	return { older, cliVersion, targetVersion };
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
		if (current[key] === undefined) missing[key] = VERSION_DEFAULTS[key];
	}
	writeVersionState(state, missing);
	migrateManagedMarkersToPinList(state);
	stripRetiredStackEnvKeys(state);
}

/**
 * One-shot: carry pins recorded in the retired OP_MANAGED_*_VERSION markers
 * over to {@link PINNED_IMAGES_KEY}, so an operator's existing pin survives the
 * markers being deleted (#679).
 *
 * The old encoding, read once and then thrown away:
 *   marker BLANK          -> writeVersions wrote it: a deliberate operator pin.
 *   marker EQUAL to value -> release-managed.
 *   marker DIFFERENT      -> nobody wrote this on purpose. It is the drift that
 *                            silently froze image updates while reporting
 *                            success, so it is NOT carried over as a pin.
 *
 * Skipped entirely once OP_PINNED_IMAGES exists, so it can never re-derive pins
 * from stale rows and undo a later unpin.
 */
function migrateManagedMarkersToPinList(state: ControlPlaneState): void {
	const path = stackEnvFile(state.homeDir);
	if (!existsSync(path)) return;
	const current = parseEnvFile(path);
	if (current[PINNED_IMAGES_KEY] !== undefined) return;
	const markers = SERVICE_VERSION_KEYS.map((key) => [key, `OP_MANAGED_${versionKeyToService(key).toUpperCase()}_VERSION`] as const);
	if (!markers.some(([, marker]) => current[marker] !== undefined)) return;
	const pinned = markers
		.filter(([key, marker]) => current[marker]?.trim() === '' && (current[key]?.trim() ?? '') !== '')
		.map(([key]) => key);
	writePinnedImages(state, pinned);
}

/** Drop {@link RETIRED_STACK_ENV_KEYS} from `state/stack.env`. No-op once clean. */
export function stripRetiredStackEnvKeys(state: ControlPlaneState): boolean {
	const path = stackEnvFile(state.homeDir);
	if (!existsSync(path)) return false;
	const content = readFileSync(path, 'utf-8');
	const parsed = parseEnvFile(path);
	const retired = RETIRED_STACK_ENV_KEYS.filter((key) => Object.hasOwn(parsed, key));
	if (retired.length === 0) return false;
	let next = content;
	for (const key of retired) next = removeEnvKey(next, key);
	if (next === content) return false;
	writeFileAtomic(path, next, 0o600);
	return true;
}

/**
 * Set every platform image to the release this app IS. Called by the update
 * lifecycle; returns what it wrote so `openpalm update` can print it.
 *
 * An unpinned image gets this release's tag — including over a `rollback-*`
 * tag left by a previous failed upgrade, and over a stale tag a past release
 * wrote. Pins are read from OP_PINNED_IMAGES and honoured, and every skipped
 * image is reported back to the caller so the operator is told it was skipped
 * (#679: silence is what made a frozen stack look like a successful upgrade).
 *
 * Three things are left alone, and `update` names every one of them in its
 * output — a skipped image must never again be indistinguishable from an
 * updated one (#679):
 *
 * - An image the operator PINNED (`OP_PINNED_IMAGES`). That is the whole point
 *   of a pin, and it is one explicit bit, not an inference.
 * - Voice. Its tags are accelerator-variant suffixed (`latest-cpu`,
 *   `v1.4.0-cu121`) and it ships on its own cadence, so no bare
 *   platform-version voice image is ever published.
 * - A `dev` tag. That is a local build no registry has; an update that
 *   repointed it at a published tag would silently replace the images a
 *   developer (and the smoke scripts) built and are running.
 */
export type DeployedImageVersions = {
	/** Keys written to the release version. */
	updated: Record<string, string>;
	/** Keys left as they were, and why — for `update` to print. */
	skipped: Array<{ key: VersionKey; version: string; reason: 'pinned' | 'voice' | 'dev' }>;
};

export function setPlatformImageVersions(
	state: ControlPlaneState,
	targetPlatformVersion = PLATFORM_VERSION
): DeployedImageVersions {
	const current = parseEnvFile(stackEnvFile(state.homeDir));
	const pinned = readPinnedImages(state);
	const updated: Record<string, string> = {};
	const skipped: DeployedImageVersions['skipped'] = [];
	for (const key of SERVICE_VERSION_KEYS) {
		const version = current[key]?.trim() || VERSION_DEFAULTS[key];
		if (pinned.has(key)) skipped.push({ key, version, reason: 'pinned' });
		else if (key === 'OP_VOICE_VERSION') skipped.push({ key, version, reason: 'voice' });
		else if (version.startsWith('dev')) skipped.push({ key, version, reason: 'dev' });
		else updated[key] = targetPlatformVersion;
	}
	writeVersionState(state, updated);
	return { updated, skipped };
}

/**
 * Write image tags to `state/stack.env` (atomically: temp + rename). Only
 * SERVICE_VERSION_KEYS are accepted, so a typo or hostile caller can't smuggle
 * arbitrary env into the stack config. mergeEnvContent preserves existing keys
 * and comments. Values are persisted verbatim, `latest` and `next` included.
 *
 * A value written here holds until the next `openpalm update`, which deploys
 * that release's images (see setPlatformImageVersions).
 */
export function writeVersions(state: ControlPlaneState, updates: Record<string, string>): void {
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
	}
	writeVersionState(state, accepted);
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

function writeVersionState(state: ControlPlaneState, updates: Record<string, string>): void {
	if (Object.keys(updates).length === 0) return;
	const path = stackEnvFile(state.homeDir);
	mkdirSync(`${state.homeDir}/state`, { recursive: true, mode: 0o700 });
	const current = existsSync(path) ? readFileSync(path, 'utf-8') : '';
	writeFileAtomic(path, mergeEnvContent(current, updates), 0o600);
}
