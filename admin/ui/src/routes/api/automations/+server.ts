import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getAutomationStore } from '$lib/server/stores';
import { controllerAction } from '$lib/server/helpers';
import { validateCron } from '$lib/server/automation-store';

export const GET: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  return json({ automations: getAutomationStore().list() });
};

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { name?: string; schedule?: string; prompt?: string };
  if (!body.name || !body.schedule || !body.prompt) {
    return json({ error: "name, schedule, and prompt are required" }, { status: 400 });
  }
  const cronError = validateCron(body.schedule);
  if (cronError) return json({ error: `invalid cron expression: ${cronError}` }, { status: 400 });

  const store = getAutomationStore();
  const automation = {
    id: randomUUID(),
    name: body.name,
    schedule: body.schedule,
    prompt: body.prompt,
    status: "enabled" as const,
    createdAt: new Date().toISOString(),
  };
  store.add(automation);
  store.writeCrontab();
  await controllerAction("restart", "opencode-core", `automation created: ${automation.name}`);
  return json({ ok: true, automation }, { status: 201 });
};
