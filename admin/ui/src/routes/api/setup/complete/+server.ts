import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getSetupManager } from '$lib/server/stores';

export const POST: RequestHandler = async ({ request }) => {
  const setupManager = getSetupManager();
  const current = setupManager.getState();

  if (current.completed === true && request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }

  const state = setupManager.completeSetup();
  return json({ ok: true, state });
};
