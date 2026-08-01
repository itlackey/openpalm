/**
 * HTTP transport for talking to the active OpenCode endpoint.
 *
 * Used by sibling modules (`config.ts`, `catalog.ts`) — not part of the
 * public API of `$lib/server/opencode`. Reads the active endpoint per-call
 * so user switches in the UI take effect immediately.
 */
import { assistantAuthHeaders } from '../basic-auth.js';
import { getAssistantOpencodeTarget } from '../opencode-target.js';

export interface OpencodeFetchTarget {
	url: string;
	username?: string;
	password?: string;
}

/**
 * `target` is an explicit override for the `/api/setup/*` namespace (W1):
 * on a fresh host the deployed assistant isn't up yet, so setup-time callers
 * resolve their own target (`setup-target.ts`, preferring the wizard-spawned
 * OpenCode instance) rather than always hitting `getAssistantOpencodeTarget()`.
 * Every other caller omits it and keeps today's behavior unchanged.
 */
export async function opencodeFetch<T>(
	path: string,
	init?: RequestInit,
	target?: OpencodeFetchTarget,
): Promise<T> {
	const endpoint = target ?? getAssistantOpencodeTarget();
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		...(init?.headers as Record<string, string> | undefined),
		...assistantAuthHeaders(endpoint),
	};
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
