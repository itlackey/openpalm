import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { setChannelAccess, controllerAction, type ChannelName } from '$lib/server/helpers';

export const POST: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  const body = await request.json() as { channel: ChannelName; access: "lan" | "public" };
  if (!["chat", "voice", "discord", "telegram"].includes(body.channel)) {
    return json({ error: "invalid channel" }, { status: 400 });
  }
  if (!["lan", "public"].includes(body.access)) {
    return json({ error: "invalid access" }, { status: 400 });
  }
  setChannelAccess(body.channel, body.access);
  await controllerAction("restart", "caddy", `channel ${body.channel} access ${body.access}`);
  return json({ ok: true, channel: body.channel, access: body.access });
};
