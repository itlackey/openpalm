/**
 * HTTP transport for talking to the local OpenCode server.
 *
 * Used by sibling modules (`config.ts`, `catalog.ts`) — not part of the
 * public API of `$lib/server/opencode`.
 */

const OPENCODE_URL =
	process.env.OP_OPENCODE_URL ?? process.env.OP_ASSISTANT_URL ?? 'http://localhost:4096';

export async function opencodeFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${OPENCODE_URL}${path}`, {
		headers: {
			'content-type': 'application/json',
			...(init?.headers ?? {}),
		},
		...init,
	});

	if (!response.ok) {
		throw new Error(`${init?.method ?? 'GET'} ${path} failed with ${response.status}`);
	}

	if (response.status === 204) {
		return undefined as T;
	}

	return (await response.json()) as T;
}
