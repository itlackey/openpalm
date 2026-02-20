import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN, OPENCODE_CORE_URL } from '$lib/server/env';
import { getAutomationStore } from '$lib/server/stores';

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { id?: string };
  if (!body.id) return json({ error: "id is required" }, { status: 400 });
  const job = getAutomationStore().get(body.id);
  if (!job) return json({ error: "automation not found" }, { status: 404 });
  // Fire directly against opencode-core without waiting for cron
  fetch(`${OPENCODE_CORE_URL}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: job.prompt,
      session_id: `cron-${job.id}`,
      user_id: "cron-scheduler",
      metadata: { source: "automation", automationId: job.id, automationName: job.name },
    }),
    signal: AbortSignal.timeout(120_000),
  }).catch(() => {});
  return json({ ok: true, triggered: job.id });
};
