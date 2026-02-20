import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getProviderStore } from '$lib/server/stores';
import { fetchModelsFromProvider } from '$lib/server/helpers';

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { providerId?: string };
  if (!body.providerId) return json({ error: "providerId is required" }, { status: 400 });
  const provider = getProviderStore().getProvider(body.providerId);
  if (!provider) return json({ error: "provider not found" }, { status: 404 });
  try {
    const models = await fetchModelsFromProvider(provider.url, provider.apiKey);
    return json({ ok: true, models });
  } catch (e) {
    return json({ error: "failed to fetch models", message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
};
