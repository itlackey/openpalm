/**
 * HTTP transport for talking to the local OpenCode server.
 *
 * Used by sibling modules (`config.ts`, `catalog.ts`) — not part of the
 * public API of `$lib/server/opencode`.
 */

// Lazy: read at call time so any env loading that happens during server startup
// (e.g. reading stack.env) is reflected. OP_ASSISTANT_PORT is the HOST-side port
// the assistant container is mapped to. The old default of 4096 was container-internal.
function openCodeUrl(): string {
	return (
		process.env.OP_OPENCODE_URL ??
		process.env.OP_ASSISTANT_URL ??
		`http://localhost:${process.env.OP_ASSISTANT_PORT ?? '3800'}`
	);
}

export async function opencodeFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${openCodeUrl()}${path}`, {
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
