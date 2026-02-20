import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN, KNOWN_SERVICES } from '$lib/server/env';
import { controllerAction } from '$lib/server/helpers';

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { service: string };
  if (!body.service || !KNOWN_SERVICES.has(body.service)) return json({ error: "unknown service name" }, { status: 400 });
  const result = await controllerAction("restart", body.service, "admin action");
  if (!result.ok) return json({ ok: false, error: result.error, action: "restart", service: body.service }, { status: 502 });
  return json({ ok: true, action: "restart", service: body.service });
};
