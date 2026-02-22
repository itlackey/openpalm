import { unauthorizedJson } from '$lib/server/json';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	return new Response(
		`event: ready\ndata: {"ok":true,"service":"admin"}\n\n`,
		{
			status: 200,
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				connection: 'keep-alive',
				'access-control-allow-origin': '*'
			}
		}
	);
};
