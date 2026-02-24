import { json, unauthorizedJson } from '$lib/server/json';
import { knownServices } from '$lib/server/init';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const services = Array.from(await knownServices()).sort();
	return json(200, { services });
};
