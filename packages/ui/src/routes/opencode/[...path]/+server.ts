import { json } from '$lib/server/json';
import { OPENCODE_CORE_URL } from '$lib/server/config';
import type { RequestHandler } from './$types';

const handler: RequestHandler = async ({ params, url, request }) => {
	const subpath = params.path ? `/${params.path}` : '/';
	const target = `${OPENCODE_CORE_URL}${subpath}${url.search}`;
	try {
		const proxyResp = await fetch(target, {
			method: request.method,
			headers: request.headers,
			body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
			signal: AbortSignal.timeout(5000),
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
