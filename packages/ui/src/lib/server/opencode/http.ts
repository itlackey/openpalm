/**
 * HTTP transport for talking to the active OpenCode endpoint.
 *
 * Used by sibling modules (`config.ts`, `catalog.ts`) — not part of the
 * public API of `$lib/server/opencode`. Reads the active endpoint per-call
 * so user switches in the UI take effect immediately.
 */
import { basicAuthHeader } from '../basic-auth.js';
import { getActiveEndpoint } from '../endpoints.js';

export async function opencodeFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const endpoint = getActiveEndpoint();
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		...(init?.headers as Record<string, string> | undefined),
	};
	if (endpoint.password) {
		// PR #564 r3566888629: default to OpenCode's server username 'opencode'.
		const user = endpoint.username || 'opencode';
		headers.authorization = basicAuthHeader(user, endpoint.password);
	}
	const response = await fetch(`${endpoint.url}${path}`, {
		...init,
		headers,
	});

	if (!response.ok) {
		throw new Error(`${init?.method ?? 'GET'} ${path} failed with ${response.status}`);
	}

	if (response.status === 204) {
		return undefined as T;
	}

	return (await response.json()) as T;
}
