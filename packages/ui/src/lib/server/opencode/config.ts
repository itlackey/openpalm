/**
 * OpenCode config read/write + small mutation helpers.
 *
 * Writes the operator's `opencode.json` directly, because OpenCode's
 * PATCH /config mutates only the live process and persists nothing. We still
 * call PATCH afterwards (best-effort) so the running assistant picks up the
 * change without a restart.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asRecord } from '../coercion.js';
import { opencodeFetch } from './http.js';

export type JsonRecord = Record<string, unknown>;

export type RawConfig = JsonRecord & {
	provider?: Record<string, JsonRecord>;
	model?: string;
	small_model?: string;
	enabled_providers?: string[];
	disabled_providers?: string[];
};

function configPath(): string {
	// This module serves two deployments of the same routes:
	//  - HOST-SERVED surfaces (setup wizard, desktop shell) run with OP_HOME
	//    set and no container mounts: the file is
	//    `$OP_HOME/config/assistant/opencode.json`.
	//  - The ADMIN UI co-process runs INSIDE the assistant container, where
	//    the entrypoint deliberately injects no OP_HOME (no host path may leak
	//    into the container). There the SAME file is the read-write bind mount
	//    at `~/.config/opencode/opencode.json` (core.compose.yml mounts
	//    `config/assistant` on `/home/opencode/.config/opencode`).
	// The old `OP_HOME ?? ''` resolved to a RELATIVE `config/assistant/…`
	// against the UI server's cwd in the container, so every preferred-model
	// save either errored (missing cwd subdirs) or landed in a phantom file
	// the assistant never reads, while the best-effort live PATCH made it look
	// saved — until the next restart dropped it.
	const opHome = process.env.OP_HOME;
	if (opHome) return join(opHome, 'config', 'assistant', 'opencode.json');
	return join(homedir(), '.config', 'opencode', 'opencode.json');
}

export async function getCurrentConfig(): Promise<RawConfig> {
	// Read from disk — OpenCode's in-memory config may not reflect disk changes
	try {
		return JSON.parse(readFileSync(configPath(), 'utf-8')) as RawConfig;
	} catch {
		// Fallback to OpenCode API if disk read fails
		return opencodeFetch<RawConfig>('/config');
	}
}

export async function patchConfig(config: RawConfig, removeKeys: readonly string[] = []): Promise<RawConfig> {
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(readFileSync(configPath(), 'utf-8'));
	} catch {
		// file missing or invalid — start fresh
	}

	// Merge provider config into existing
	const merged = { ...existing, ...config };
	if (config.provider) {
		(merged as Record<string, unknown>).provider = {
			...((existing.provider as Record<string, unknown>) ?? {}),
			...(config.provider as Record<string, unknown>),
		};
	}
	// Deletions must be explicit: `merged` starts from what is ON DISK, so a
	// key a caller removed from its own in-memory copy silently resurrects in
	// the spread above (that is how "clear model" never actually cleared).
	for (const key of removeKeys) {
		delete (merged as Record<string, unknown>)[key];
	}

	writeFileSync(configPath(), `${JSON.stringify(merged, null, 2)}\n`);

	// Also notify OpenCode to reload (best-effort). PATCH cannot express a
	// removal, so an unset key reaches the live process on its next restart.
	await opencodeFetch<RawConfig>('/config', {
		method: 'PATCH',
		body: JSON.stringify(config),
	}).catch(() => {});

	return merged as RawConfig;
}

export function normalizeProviderConfig(providerConfig: JsonRecord | undefined) {
	const normalized = providerConfig ? { ...providerConfig } : {};
	const options = asRecord(normalized.options);

	if (options && Object.keys(options).length === 0) {
		delete normalized.options;
	}

	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function setProviderEnabled(config: RawConfig, providerId: string, enabled: boolean) {
	const disabled = new Set(config.disabled_providers ?? []);
	const allowlist = config.enabled_providers ? new Set(config.enabled_providers) : undefined;

	if (enabled) {
		disabled.delete(providerId);
		allowlist?.add(providerId);
	} else {
		disabled.add(providerId);
		allowlist?.delete(providerId);
	}

	config.disabled_providers = Array.from(disabled).sort();

	if (allowlist) {
		config.enabled_providers = Array.from(allowlist).sort();
	}

	return config;
}

/** Save non-credential connection options (baseURL, headers, timeout, etc.) for a provider. */
export async function setProviderOptions(
	providerId: string,
	options: {
		baseURL?: string;
		enterpriseUrl?: string;
		timeout?: number;
		setCacheKey?: boolean;
		headers?: Record<string, string> | null;
	},
): Promise<void> {
	const config = await getCurrentConfig();
	const providerConfig = { ...(config.provider ?? {}) };
	const current = asRecord(providerConfig[providerId]) ?? {};
	const currentOptions = asRecord(current.options) ?? {};
	const nextOptions: Record<string, unknown> = { ...currentOptions };

	// Credentials must not live here — strip any stale apiKey.
	delete nextOptions.apiKey;

	if (options.baseURL) nextOptions.baseURL = options.baseURL; else delete nextOptions.baseURL;
	if (options.enterpriseUrl) nextOptions.enterpriseUrl = options.enterpriseUrl; else delete nextOptions.enterpriseUrl;
	if (options.timeout !== undefined && options.timeout > 0) nextOptions.timeout = options.timeout; else delete nextOptions.timeout;
	if (options.setCacheKey === true) nextOptions.setCacheKey = true; else delete nextOptions.setCacheKey;
	if (options.headers && Object.keys(options.headers).length > 0) nextOptions.headers = options.headers;
	else delete nextOptions.headers;

	const nextEntry = normalizeProviderConfig({ ...current, options: nextOptions });
	if (nextEntry) providerConfig[providerId] = nextEntry;
	else delete providerConfig[providerId];

	config.provider = providerConfig;
	await patchConfig(config);
}

/** Register a provider entry (local-detected or fully custom) in opencode.json. */
export async function registerProvider(
	providerId: string,
	entry: {
		npm?: string;
		name?: string;
		options?: Record<string, unknown>;
		models?: Record<string, unknown>;
	},
	overwrite = false,
): Promise<{ alreadyExists: boolean }> {
	const config = await getCurrentConfig();
	const providerConfig = { ...(config.provider ?? {}) };

	if (providerConfig[providerId] && !overwrite) {
		return { alreadyExists: true };
	}

	const existing = asRecord(providerConfig[providerId]);
	providerConfig[providerId] = {
		...existing,
		...(entry.npm !== undefined ? { npm: entry.npm } : {}),
		...(entry.name !== undefined ? { name: entry.name } : {}),
		...(entry.options !== undefined ? { options: entry.options } : {}),
		...(entry.models !== undefined ? { models: entry.models } : {}),
	};

	config.provider = providerConfig;
	await patchConfig(config);
	return { alreadyExists: false };
}

/**
 * Set the main model (or small model) in opencode.json.
 *
 * Deliberately a DELTA, not a read-modify-write of getCurrentConfig():
 * getCurrentConfig falls back to OpenCode's live /config when the disk file
 * is unreadable, and persisting that snapshot would bake every runtime-merged
 * value into the operator's file. patchConfig merges the delta over what is
 * actually on disk.
 */
export async function setMainModel(
	providerId: string,
	modelId: string,
	target: 'model' | 'small_model',
): Promise<void> {
	await patchConfig({ [target]: `${providerId}/${modelId}` });
}

/** Clear the main model (or small model) in opencode.json. */
export async function unsetMainModel(target: 'model' | 'small_model'): Promise<void> {
	await patchConfig({}, [target]);
}
