/**
 * OAuth helpers for the in-process OpenCode auth subprocess.
 *
 * `baseUrl` is supplied by the route layer (`opencode-auth-subprocess.ts`
 * spins one up on a random port), so these are pure HTTP wrappers — no
 * dependency on the `OP_OPENCODE_URL` env used by the main server.
 */

export async function startOauthFlowAtBase(
	baseUrl: string,
	providerId: string,
	methodIndex: number,
	inputs?: Record<string, string>
) {
	const response = await fetch(`${baseUrl}/provider/${providerId}/oauth/authorize`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ method: methodIndex, inputs }),
	});

	if (!response.ok) {
		throw new Error(`POST /provider/${providerId}/oauth/authorize failed with ${response.status}`);
	}

	return (await response.json()) as { url: string; method: 'auto' | 'code'; instructions?: string };
}

export async function finishOauthFlowAtBase(
	baseUrl: string,
	providerId: string,
	methodIndex: number,
	code: string
) {
	const response = await fetch(`${baseUrl}/provider/${providerId}/oauth/callback`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ method: methodIndex, code }),
	});

	if (!response.ok) {
		throw new Error(`POST /provider/${providerId}/oauth/callback failed with ${response.status}`);
	}

	if (response.status === 204) return true;
	return (await response.json()) as boolean;
}
