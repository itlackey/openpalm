import { get } from 'svelte/store';
import { authToken, clearToken } from './stores/auth';
import type { ApiResult } from './types';

/** Handle 401 responses by clearing the token and reloading to show login */
function handle401() {
	clearToken();
	if (typeof window !== 'undefined') {
		window.location.reload();
	}
}

/**
 * Build the API path. All API routes live under /admin/api/*.
 * Callers pass the old-style path (e.g. '/admin/setup/status')
 * and we rewrite it to '/admin/api/setup/status'.
 */
function buildApiPath(path: string): string {
	// Already has /api/ prefix
	if (path.startsWith('/admin/api/')) return path;
	// Rewrite /admin/* to /admin/api/*
	if (path.startsWith('/admin/')) {
		return '/admin/api/' + path.slice('/admin/'.length);
	}
	// For paths like /health that are outside /admin
	return path;
}

export async function api<T = unknown>(
	path: string,
	opts: RequestInit & { noAuth?: boolean } = {}
): Promise<ApiResult<T>> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		...(opts.headers as Record<string, string> || {})
	};

	const token = get(authToken);
	if (token && !opts.noAuth) {
		headers['x-admin-token'] = token;
	}

	const url = buildApiPath(path);

	try {
		const res = await fetch(url, { ...opts, headers });
		const text = await res.text();
		let data: T;
		try {
			data = JSON.parse(text);
		} catch {
			data = text as unknown as T;
		}
		if (res.status === 401 && !opts.noAuth && token) {
			handle401();
		}
		return { ok: res.ok, status: res.status, data };
	} catch {
		return {
			ok: false,
			status: 0,
			data: { error: 'Server unreachable. Check that OpenPalm is running.' } as unknown as T
		};
	}
}

/** GET helper */
export function apiGet<T = unknown>(path: string, opts: RequestInit & { noAuth?: boolean } = {}) {
	return api<T>(path, { ...opts, method: 'GET' });
}

/** POST helper */
export function apiPost<T = unknown>(path: string, body?: unknown, opts: RequestInit & { noAuth?: boolean } = {}) {
	return api<T>(path, { ...opts, method: 'POST', body: body ? JSON.stringify(body) : undefined });
}

/** Fetch raw text (e.g., config file) */
export async function apiGetText(path: string): Promise<ApiResult<string>> {
	const token = get(authToken);
	const headers: Record<string, string> = {};
	if (token) headers['x-admin-token'] = token;

	const url = buildApiPath(path);
	try {
		const res = await fetch(url, { headers });
		const text = await res.text();
		if (res.status === 401 && token) {
			handle401();
		}
		return { ok: res.ok, status: res.status, data: text };
	} catch {
		return { ok: false, status: 0, data: '' };
	}
}
