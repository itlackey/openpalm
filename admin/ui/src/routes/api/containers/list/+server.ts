import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN, CONTROLLER_URL, CONTROLLER_TOKEN } from '$lib/server/env';

export const GET: RequestHandler = async ({ request }) => {
  if (request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }
  if (!CONTROLLER_URL) return json({ error: "controller not configured" }, { status: 503 });
  const resp = await fetch(`${CONTROLLER_URL}/containers`, {
    headers: { "x-controller-token": CONTROLLER_TOKEN }
  });
  return new Response(await resp.text(), { status: resp.status, headers: { "content-type": "application/json" } });
};
