import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { ModelAssignment } from '@openpalm/lib';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getProviderStore } from '$lib/server/stores';
import { applyProviderAssignment, controllerAction } from '$lib/server/helpers';

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { role?: string; providerId?: string; modelId?: string };
  if (!body.role || !body.providerId || !body.modelId) {
    return json({ error: "role, providerId, and modelId are required" }, { status: 400 });
  }
  if (body.role !== "small" && body.role !== "openmemory") {
    return json({ error: "role must be 'small' or 'openmemory'" }, { status: 400 });
  }
  const store = getProviderStore();
  const provider = store.getProvider(body.providerId);
  if (!provider) return json({ error: "provider not found" }, { status: 404 });
  const state = store.assignModel(body.role as ModelAssignment, body.providerId, body.modelId);
  applyProviderAssignment(body.role as ModelAssignment, provider.url, provider.apiKey, body.modelId);
  await controllerAction("restart", "opencode-core", `provider assignment: ${body.role}=${body.modelId}`);
  return json({ ok: true, assignments: state.assignments });
};
