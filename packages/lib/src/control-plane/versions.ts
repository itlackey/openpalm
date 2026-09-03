/**
 * Image tag resolution for the OpenPalm stack (§4.2, §5).
 *
 * THE RULE, in one sentence: an image runs the tag the release baked into its
 * own `system/stack/*.compose.yml` as a Compose `:-` default, unless
 * `state/stack.env` carries a row for that image — in which case the row wins.
 *
 * Presence of the row IS the pin. Absence IS "follow the release". Nothing
 * records which one a value is, because nothing needs to: the app never writes
 * a version row, so a row can only have come from an operator.
 *
 * That replaced (#679) four OP_MANAGED_*_VERSION shadow keys whose pairwise
 * relationship with the real key encoded the same bit — equal meant
 * release-managed, blank meant pinned, and present-but-different meant nothing
 * anyone wrote on purpose, which silently froze a live instance on 0.13.1
 * while `openpalm update` reported success for months. Three earlier versions
 * of the same idea (#471, #537, #639) failed the same way: production code
 * inferring an operator's intent from a stored value.
 *
 * `system/stack/` is overwritten from the packaged skeleton on every update, so
 * delivering the compose topology and delivering the tag are now the same copy.
 * There is no "advance the image versions" step left that can be skipped.
 *
 * Tool package versions are managed via per-container package.json files at
 * OP_HOME/data/<container>/tools/package.json.
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

/**
 * The tag each image falls back to when stack.env carries no row — i.e. the
 * `:-` default written into the shipped compose files. Nothing seeds these into
 * stack.env; they exist so the UI and CLI can SHOW what "unpinned" resolves to
 * without parsing YAML. The compose files remain the source of truth, and
 * skeleton-guardrail.test.ts asserts the two agree on every CI run.
 */
export const VERSION_DEFAULTS: Record<VersionKey, string> = {
	OP_ASSISTANT_VERSION: PLATFORM_VERSION,
	OP_GUARDIAN_VERSION: PLATFORM_VERSION,
	OP_PORTAL_VERSION: PLATFORM_VERSION,
	OP_VOICE_VERSION: 'latest'
};

export function isVersionKey(key: string): key is VersionKey {
	return VERSION_KEY_SET.has(key);
}

/** `OP_ASSISTANT_VERSION` <-> `assistant`, for display and image names. */
export function versionKeyToService(key: VersionKey): string {
	return key.slice('OP_'.length).replace('_VERSION', '').toLowerCase();
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
 * The image tags an operator has pinned in `state/stack.env`. A key is absent
 * when nothing is pinned — absence is reported as absence, never filled in with
 * a default, because a filled-in value is indistinguishable from a pin and that
 * confusion is the whole of #679.
 */
export function readVersionPins(state: ControlPlaneState): Partial<Record<VersionKey, string>> {
	const fromState = parseEnvFile(stackEnvFile(state.homeDir));
	const pins: Partial<Record<VersionKey, string>> = {};
	for (const key of SERVICE_VERSION_KEYS) {
		const value = fromState[key]?.trim();
		if (value) pins[key] = value;
	}
	return pins;
}

/**
 * What each image resolves to right now: the operator's pin when there is one,
 * otherwise the release default the compose file carries. For DISPLAY and for
 * the update report — never written back anywhere.
 */
export function resolveVersions(state: ControlPlaneState): Record<VersionKey, string> {
	const pins = readVersionPins(state);
	return Object.fromEntries(
		SERVICE_VERSION_KEYS.map((key) => [key, pins[key] ?? VERSION_DEFAULTS[key]])
	) as Record<VersionKey, string>;
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
 * Set or clear operator pins in `state/stack.env`. Only SERVICE_VERSION_KEYS
 * are accepted, so a typo or hostile caller can't smuggle arbitrary env into
 * the stack config.
 *
 * An EMPTY value removes the row, which is how an operator unpins: the image
 * goes back to the release default in the compose file. Compose treats
 * set-but-empty as unset anyway, so leaving a blank row behind would be a
 * second way to say the same thing — and this project has now hand-modelled
 * "blank means something" four separate times (#471, #537, #639, #679).
 */
export function writeVersions(state: ControlPlaneState, updates: Record<string, string>): void {
	const sets: Record<string, string> = {};
	const removals: VersionKey[] = [];
	for (const [key, value] of Object.entries(updates)) {
		if (!isVersionKey(key)) {
			throw new Error(`Refusing to write unknown version key: ${key}`);
		}
		const trimmed = (value ?? '').trim();
		if (!trimmed) {
			removals.push(key);
			continue;
		}
		if (key === 'OP_VOICE_VERSION' && VOICE_VARIANT_SUFFIX_RE.test(trimmed)) {
			throw new Error(
				`OP_VOICE_VERSION is the base image tag; Compose appends the accelerator suffix itself. Use "${trimmed.replace(VOICE_VARIANT_SUFFIX_RE, '')}" instead of "${trimmed}", or the image resolves to a tag that does not exist.`
			);
		}
		sets[key] = trimmed;
	}
	if (removals.length === 0) {
		writeVersionState(state, sets);
		return;
	}
	const path = stackEnvFile(state.homeDir);
	mkdirSync(`${state.homeDir}/state`, { recursive: true, mode: 0o700 });
	let content = existsSync(path) ? readFileSync(path, 'utf-8') : '';
	for (const key of removals) content = removeEnvKey(content, key);
	writeFileAtomic(path, mergeEnvContent(content, sets), 0o600);
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
