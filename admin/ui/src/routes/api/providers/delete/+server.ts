import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getProviderStore } from '$lib/server/stores';
import { updateSecretsEnv, controllerAction } from '$lib/server/helpers';

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { id?: string };
  if (!body.id) return json({ error: "id is required" }, { status: 400 });
  const store = getProviderStore();
  // Capture which roles used this provider before removal
  const stateBefore = store.getState();
  const affectedRoles = Object.entries(stateBefore.assignments)
    .filter(([, assignment]) => assignment.providerId === body.id)
    .map(([role]) => role);
  const removed = store.removeProvider(body.id);
  if (!removed) return json({ error: "provider not found" }, { status: 404 });
  // Clear env vars and restart services that depended on the deleted provider
  for (const role of affectedRoles) {
    if (role === "small") {
      updateSecretsEnv({ OPENPALM_SMALL_MODEL_API_KEY: undefined });
      await controllerAction("restart", "opencode-core", `provider deleted: ${role} assignment cleared`);
    }
    if (role === "openmemory") {
      updateSecretsEnv({ OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
      await controllerAction("restart", "opencode-core", `provider deleted: ${role} assignment cleared`);
      await controllerAction("restart", "openmemory", `provider deleted: openmemory assignment cleared`);
    }
  }
  return json({ ok: true, deleted: body.id });
};
