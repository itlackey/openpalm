import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getProviderStore } from '$lib/server/stores';

export const GET: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const store = getProviderStore();
  const providers = store.listProviders().map((p) => ({
    ...p,
    apiKey: p.apiKey ? "••••••" : "",
  }));
  return json({ providers, assignments: store.getState().assignments });
};

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { name?: string; url?: string; apiKey?: string };
  if (!body.name) return json({ error: "name is required" }, { status: 400 });
  const store = getProviderStore();
  const existing = store.listProviders();
  if (existing.some((p) => p.name.toLowerCase() === body.name!.toLowerCase())) {
    return json({ error: "a provider with this name already exists" }, { status: 409 });
  }
  const provider = store.addProvider({
    name: body.name,
    url: body.url ?? "",
    apiKey: body.apiKey ?? "",
  });
  return json({ ok: true, provider: { ...provider, apiKey: provider.apiKey ? "••••••" : "" } }, { status: 201 });
};
