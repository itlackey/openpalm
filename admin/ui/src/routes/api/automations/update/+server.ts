import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getAutomationStore } from '$lib/server/stores';
import { controllerAction } from '$lib/server/helpers';
import { validateCron } from '$lib/server/automation-store';

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { id?: string; name?: string; schedule?: string; prompt?: string; status?: "enabled" | "disabled" };
  if (!body.id) return json({ error: "id is required" }, { status: 400 });
  if (body.schedule) {
    const cronError = validateCron(body.schedule);
    if (cronError) return json({ error: `invalid cron expression: ${cronError}` }, { status: 400 });
  }
  const store = getAutomationStore();
  const { id, ...fields } = body;
  const updated = store.update(id, fields);
  if (!updated) return json({ error: "automation not found" }, { status: 404 });
  store.writeCrontab();
  await controllerAction("restart", "opencode-core", `automation updated: ${updated.name}`);
  return json({ ok: true, automation: updated });
};
