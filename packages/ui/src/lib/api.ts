import { base } from '$app/paths';
import { getAdminToken } from './stores/auth.svelte.ts';

interface ApiResult {
	ok: boolean;
	status: number;
	data: any;
}

export async function api(path: string, opts: RequestInit = {}): Promise<ApiResult> {
	const token = getAdminToken();
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		...(opts.headers as Record<string, string> ?? {})
	};
	if (token) headers['x-admin-token'] = token;

	// All API paths are relative to the base path
	const url = `${base}${path}`;

	try {
		const res = await fetch(url, { ...opts, headers });
		const text = await res.text();
		try {
			return { ok: res.ok, status: res.status, data: JSON.parse(text) };
		} catch {
			return { ok: res.ok, status: res.status, data: text };
		}
	} catch {
		return {
			ok: false,
			status: 0,
			data: { error: 'Server unreachable. Check that OpenPalm is running.' }
		};
	}
}
