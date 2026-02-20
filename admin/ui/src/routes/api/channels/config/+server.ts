import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN, CHANNEL_SERVICES } from '$lib/server/env';
import { readChannelConfig, writeChannelConfig, controllerAction } from '$lib/server/helpers';

export const GET: RequestHandler = async ({ request, url }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const service = url.searchParams.get("service") ?? "";
  if (!CHANNEL_SERVICES.includes(service as (typeof CHANNEL_SERVICES)[number])) {
    return json({ error: "invalid service" }, { status: 400 });
  }
  return json({ service, config: readChannelConfig(service) });
};

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { service: string; config: Record<string, string>; restart?: boolean };
  if (!CHANNEL_SERVICES.includes(body.service as (typeof CHANNEL_SERVICES)[number])) {
    return json({ error: "invalid service" }, { status: 400 });
  }
  writeChannelConfig(body.service, body.config ?? {});
  if (body.restart ?? true) await controllerAction("up", body.service, "channel config update");
  return json({ ok: true, service: body.service });
};
