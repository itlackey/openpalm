import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getSetupManager } from '$lib/server/stores';
import {
  setAccessScope,
  setRuntimeBindScope,
  controllerAction,
} from '$lib/server/helpers';

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json()) as { scope: "host" | "lan" };

  if (!["host", "lan"].includes(body.scope)) {
    return json({ error: "invalid scope" }, { status: 400 });
  }

  const setupManager = getSetupManager();
  const current = setupManager.getState();

  if (current.completed && request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }

  setAccessScope(body.scope);
  setRuntimeBindScope(body.scope);

  // Use "restart" for Caddy so it reloads the updated Caddyfile
  // Use "up" for services so they pick up new env_file values
  await Promise.all([
    controllerAction("restart", "caddy", `setup scope: ${body.scope}`),
    controllerAction("up", "openmemory", `setup scope: ${body.scope}`),
    controllerAction("up", "opencode-core", `setup scope: ${body.scope}`),
  ]);

  setupManager.setAccessScope(body.scope);
  const state = setupManager.completeStep("accessScope");

  return json({ ok: true, state });
};
