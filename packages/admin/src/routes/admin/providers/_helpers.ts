/**
 * Shared coercion + parsing helpers for the per-action provider routes.
 *
 * Each handler under `packages/admin/src/routes/admin/providers/<action>/`
 * imports from this file to keep the per-route +server.ts files focused on
 * their own request shape and response.
 */

export function asString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? ({ ...value } as Record<string, unknown>)
		: undefined;
}

export function updateStringOption(target: Record<string, unknown>, key: string, value: string) {
	if (value) target[key] = value;
	else delete target[key];
}

export function updateNumberOption(target: Record<string, unknown>, key: string, value: string) {
	if (!value) {
		delete target[key];
		return;
	}
	const parsed = Number(value);
	if (!Number.isNaN(parsed)) target[key] = parsed;
	else delete target[key];
}

export function updateBooleanOption(target: Record<string, unknown>, key: string, value: boolean) {
	if (value) target[key] = true;
	else delete target[key];
}

export function extractInputs(body: Record<string, unknown>): Record<string, string> {
	const inputs: Record<string, string> = {};
	for (const [key, value] of Object.entries(body)) {
		if (!key.startsWith('inputs[') || !key.endsWith(']') || typeof value !== 'string') continue;
		const inputKey = key.slice(7, -1).trim();
		if (!inputKey || value.trim().length === 0) continue;
		inputs[inputKey] = value.trim();
	}
	return inputs;
}

export function parseModels(modelsJson: string) {
	if (!modelsJson) return [];
	const parsed = JSON.parse(modelsJson) as Array<{
		id?: string;
		name?: string;
		contextLimit?: unknown;
		outputLimit?: unknown;
	}>;
	return parsed
		.filter((m) => typeof m.id === 'string' && m.id.trim().length > 0)
		.map((m) => ({
			id: m.id!.trim(),
			name: typeof m.name === 'string' ? m.name.trim() : '',
			contextLimit: parseLimit(m.contextLimit),
			outputLimit: parseLimit(m.outputLimit),
		}));
}

export function buildModelConfig(model: { id: string; name: string; contextLimit?: number; outputLimit?: number }) {
	const limit = {
		...(model.contextLimit ? { context: model.contextLimit } : {}),
		...(model.outputLimit ? { output: model.outputLimit } : {}),
	};
	return {
		...(model.name ? { name: model.name } : {}),
		...(Object.keys(limit).length > 0 ? { limit } : {}),
	};
}

function parseLimit(value: unknown): number | undefined {
	if (typeof value !== 'number' && typeof value !== 'string') return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseHeaders(headersJson: string): Record<string, string> {
	if (!headersJson) return {};
	const parsed = JSON.parse(headersJson) as Array<{ key?: string; value?: string }>;
	return Object.fromEntries(
		parsed
			.filter((h) => typeof h.key === 'string' && typeof h.value === 'string')
			.map((h) => [h.key!.trim(), h.value!.trim()])
			.filter((e) => e[0].length > 0 && e[1].length > 0)
	);
}
