/**
 * OpenCode config read/write + small mutation helpers.
 *
 * Reads/writes `OP_HOME/config/assistant/opencode.json` directly because the
 * container mount is read-only and OpenCode's PATCH /config does not persist
 * to disk. We still call PATCH afterwards (best-effort) so the live process
 * picks up the change without a restart.
 */
import { readFileSync, writeFileSync } from 'node:fs';
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
	const opHome = process.env.OP_HOME ?? '';
	return join(opHome, 'config', 'assistant', 'opencode.json');
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

export async function patchConfig(config: RawConfig): Promise<RawConfig> {
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

	writeFileSync(configPath(), JSON.stringify(merged, null, 2) + '\n');

	// Also notify OpenCode to reload (best-effort)
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
