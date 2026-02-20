import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getProviderStore } from '$lib/server/stores';

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { id?: string; name?: string; url?: string; apiKey?: string };
  if (!body.id) return json({ error: "id is required" }, { status: 400 });
  const { id, ...fields } = body;
  const updated = getProviderStore().updateProvider(id, fields);
  if (!updated) return json({ error: "provider not found" }, { status: 404 });
  return json({ ok: true, provider: { ...updated, apiKey: updated.apiKey ? "••••••" : "" } });
};
