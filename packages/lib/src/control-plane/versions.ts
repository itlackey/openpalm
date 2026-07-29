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
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { parseEnvFile, mergeEnvContent } from './env.js';
import { stackEnvFile } from './home.js';
import type { ControlPlaneState } from './types.js';
import { distTagForVersion, normalizeVersion, PLATFORM_VERSION } from './versioning.js';

/** Docker image tags — one per deployable OpenPalm image. */
export const SERVICE_VERSION_KEYS = [
	'OP_ASSISTANT_VERSION',
	'OP_GUARDIAN_VERSION',
	'OP_PORTAL_VERSION',
	'OP_VOICE_VERSION'
] as const;

export type VersionKey = (typeof SERVICE_VERSION_KEYS)[number];

const VERSION_KEY_SET: ReadonlySet<string> = new Set(SERVICE_VERSION_KEYS);
const MANAGED_VERSION_MARKERS: Record<VersionKey, string> = {
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

// ── Channel preference (constitution §4.2) ───────────────────────────────────

export type ChannelPreference = 'latest' | 'next';

const VALID_CHANNELS: ReadonlySet<string> = new Set(['latest', 'next']);

export function isChannelPreference(value: string): value is ChannelPreference {
	return VALID_CHANNELS.has(value.trim().toLowerCase());
}

/**
 * Read the channel preference from state (OP_UI_CHANNEL), falling back to the
 * legacy stack.env, then the default ("latest").
 *
 * The channel preference controls UI package self-updates. Container image tags
 * are configured directly through the version keys above.
 */
export function readChannelPreference(state: ControlPlaneState): ChannelPreference {
	const raw = (parseEnvFile(stackEnvFile(state.homeDir)).OP_UI_CHANNEL ?? '').trim().toLowerCase();
	return VALID_CHANNELS.has(raw) ? (raw as ChannelPreference) : distTagForVersion(PLATFORM_VERSION);
}

/**
 * Write the channel preference to the state file (atomically: temp + rename).
 * Only "latest" and "next" are valid; an invalid value throws.
 */
export function writeChannelPreference(state: ControlPlaneState, channel: string): void {
	const normalized = channel.trim().toLowerCase();
	if (!VALID_CHANNELS.has(normalized)) {
		throw new Error(
			`Invalid channel preference: ${JSON.stringify(channel)}. Must be "latest" or "next".`
		);
	}
	const path = stackEnvFile(state.homeDir);
	mkdirSync(`${state.homeDir}/state`, { recursive: true, mode: 0o700 });
	const current = existsSync(path) ? readFileSync(path, 'utf-8') : '';
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, mergeEnvContent(current, { OP_UI_CHANNEL: normalized }), { mode: 0o600 });
	renameSync(tmp, path);
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
			updates[key] = targetPlatformVersion;
			updates[markerKey] = targetPlatformVersion;
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
 */
export function writeVersions(state: ControlPlaneState, updates: Record<string, string>): void {
	const accepted: Record<string, string> = {};
	for (const [key, value] of Object.entries(updates)) {
		if (!isVersionKey(key)) {
			throw new Error(`Refusing to write unknown version key: ${key}`);
		}
		accepted[key] = (value ?? '').trim();
		accepted[MANAGED_VERSION_MARKERS[key]] = '';
	}
	writeVersionState(state, accepted);
}

function writeVersionState(state: ControlPlaneState, updates: Record<string, string>): void {
	if (Object.keys(updates).length === 0) return;
	const path = stackEnvFile(state.homeDir);
	mkdirSync(`${state.homeDir}/state`, { recursive: true, mode: 0o700 });
	const current = existsSync(path) ? readFileSync(path, 'utf-8') : '';
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, mergeEnvContent(current, updates), { mode: 0o600 });
	renameSync(tmp, path);
}
