import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { fetchPublicRegistry } from '$lib/server/gallery';

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const items = await fetchPublicRegistry(true);
  return json({ ok: true, total: items.length, refreshedAt: new Date().toISOString() });
};
