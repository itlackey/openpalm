import { json } from '$lib/server/json';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json(200, { ok: true, service: 'admin', time: new Date().toISOString() });
};
