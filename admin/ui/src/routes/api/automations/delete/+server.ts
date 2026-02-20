import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getAutomationStore } from '$lib/server/stores';
import { controllerAction } from '$lib/server/helpers';

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { id?: string };
  if (!body.id) return json({ error: "id is required" }, { status: 400 });
  const store = getAutomationStore();
  const removed = store.remove(body.id);
  if (!removed) return json({ error: "automation not found" }, { status: 404 });
  store.writeCrontab();
  await controllerAction("restart", "opencode-core", "automation deleted");
  return json({ ok: true, deleted: body.id });
};
