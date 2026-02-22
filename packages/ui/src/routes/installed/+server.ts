import { json, unauthorizedJson } from '$lib/server/json';
import { readInstalledPlugins } from '$lib/server/opencode-config';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const plugins = readInstalledPlugins();
	return json(200, { plugins });
};
