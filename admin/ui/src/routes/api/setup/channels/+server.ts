import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getSetupManager } from '$lib/server/stores';
import {
  normalizeSelectedChannels,
  updateRuntimeEnv,
} from '$lib/server/helpers';

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json()) as { channels?: unknown };

  const setupManager = getSetupManager();
  const current = setupManager.getState();

  if (current.completed && request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }

  const channels = normalizeSelectedChannels(body.channels);

  updateRuntimeEnv({
    OPENPALM_ENABLED_CHANNELS: channels.length ? channels.join(",") : undefined,
  });

  const state = setupManager.setEnabledChannels(channels);

  return json({ ok: true, state });
};
