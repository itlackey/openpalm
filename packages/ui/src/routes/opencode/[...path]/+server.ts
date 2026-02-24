import { json, unauthorizedJson } from '$lib/server/json';
import { OPENCODE_CORE_URL } from '$lib/server/config';
import type { RequestHandler } from './$types';

/** Headers safe to forward to the internal assistant container. */
const SAFE_FORWARD_HEADERS = ['content-type', 'accept', 'content-length'];

function buildSafeHeaders(original: Headers): Headers {
	const safe = new Headers();
	for (const name of SAFE_FORWARD_HEADERS) {
		const value = original.get(name);
		if (value) safe.set(name, value);
	}
	return safe;
}

const handler: RequestHandler = async ({ params, url, request, locals }) => {
	if (!locals.authenticated) return unauthorizedJson();

	const subpath = params.path ? `/${params.path}` : '/';
	const target = `${OPENCODE_CORE_URL}${subpath}${url.search}`;
	try {
		const proxyResp = await fetch(target, {
			method: request.method,
			headers: buildSafeHeaders(request.headers),
			body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
			signal: AbortSignal.timeout(300_000), // 5 minutes for AI responses
			// @ts-expect-error duplex needed for streaming body
			duplex: 'half'
		});
		return new Response(proxyResp.body, {
			status: proxyResp.status,
			headers: proxyResp.headers
		});
	} catch {
		return json(502, { error: 'assistant_unavailable' });
	}
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
