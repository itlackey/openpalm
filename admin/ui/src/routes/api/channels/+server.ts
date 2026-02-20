import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { listChannels } from '$lib/server/helpers';

export const GET: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  return json({ channels: listChannels() });
};
