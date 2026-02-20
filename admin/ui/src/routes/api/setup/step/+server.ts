import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getSetupManager } from '$lib/server/stores';

const VALID_STEPS = ["welcome", "accessScope", "serviceInstances", "healthCheck", "security", "channels", "extensions"] as const;
type StepName = (typeof VALID_STEPS)[number];

export const POST: RequestHandler = async ({ request }) => {
  const setupManager = getSetupManager();
  const current = setupManager.getState();

  if (current.completed && request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }

  const body = (await request.json()) as { step: string };

  if (!VALID_STEPS.includes(body.step as StepName)) {
    return json({ error: "invalid step" }, { status: 400 });
  }

  const state = setupManager.completeStep(body.step as StepName);
  return json({ ok: true, state });
};
