import type { APIRequestContext } from '@playwright/test';

export const ADMIN_TOKEN = 'test-token-e2e';

export const AUTH_HEADERS: Record<string, string> = {
	'x-admin-token': ADMIN_TOKEN,
	'content-type': 'application/json'
};

/** GET with admin auth token */
export async function authedGet(request: APIRequestContext, path: string) {
	return request.get(path, { headers: AUTH_HEADERS });
}

/** POST with admin auth token */
export async function authedPost(
	request: APIRequestContext,
	path: string,
	data: unknown
) {
	return request.post(path, {
		headers: AUTH_HEADERS,
		data
	});
}

/** POST to /command endpoint with type + payload */
export async function cmd(
	request: APIRequestContext,
	type: string,
	payload: Record<string, unknown> = {}
) {
	return authedPost(request, '/admin/command', { type, payload });
}
