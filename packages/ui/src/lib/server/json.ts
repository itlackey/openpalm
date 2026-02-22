import { json as kitJson } from '@sveltejs/kit';

export function json(status: number, payload: unknown) {
	return kitJson(payload, { status });
}

export function errorJson(status: number, error: string, details?: unknown) {
	const payload: Record<string, unknown> = { error };
	if (details !== undefined) payload.details = details;
	return json(status, payload);
}

export function unauthorizedJson() {
	return json(401, { ok: false, error: 'unauthorized', code: 'admin_token_required' });
}
