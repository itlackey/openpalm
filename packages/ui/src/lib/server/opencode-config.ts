import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseJsonc, stringifyPretty } from '@openpalm/lib/admin/jsonc.ts';
import { OPENCODE_CONFIG_PATH } from './config.ts';

export function ensureOpencodeConfigPath() {
	if (existsSync(OPENCODE_CONFIG_PATH)) return;
	mkdirSync(dirname(OPENCODE_CONFIG_PATH), { recursive: true });
	writeFileSync(OPENCODE_CONFIG_PATH, '{\n  "plugin": []\n}\n', 'utf8');
}

export function applySmallModelToOpencodeConfig(endpoint: string, modelId: string) {
	if (!modelId || !existsSync(OPENCODE_CONFIG_PATH)) return;
	const raw = readFileSync(OPENCODE_CONFIG_PATH, 'utf8');
	const doc = parseJsonc(raw) as Record<string, unknown>;
	doc.small_model = modelId;
	if (endpoint) {
		const parts = modelId.split('/');
		const providerId = parts.length > 1 ? parts[0] : 'openpalm-small';
		const providers =
			typeof doc.provider === 'object' && doc.provider !== null
				? { ...(doc.provider as Record<string, unknown>) }
				: {};
		const providerOptions: Record<string, unknown> = { baseURL: endpoint };
		providerOptions.apiKey = '{env:OPENPALM_SMALL_MODEL_API_KEY}';
		providers[providerId] = { options: providerOptions };
		doc.provider = providers;
	}
	writeFileSync(OPENCODE_CONFIG_PATH, stringifyPretty(doc), 'utf8');
}

export function readInstalledPlugins(): string[] {
	ensureOpencodeConfigPath();
	const raw = readFileSync(OPENCODE_CONFIG_PATH, 'utf8');
	const doc = parseJsonc(raw) as { plugin?: string[] };
	return Array.isArray(doc.plugin)
		? doc.plugin.filter((value): value is string => typeof value === 'string')
		: [];
}
