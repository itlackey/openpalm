import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getSetupManager } from '$lib/server/stores';
import {
  readSecretsEnv,
  getConfiguredServiceInstances,
  getConfiguredOpenmemoryProvider,
  getConfiguredSmallModel,
} from '$lib/server/helpers';

export const GET: RequestHandler = async ({ request }) => {
  const setupManager = getSetupManager();
  const state = setupManager.getState();

  if (state.completed === true && request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }

  const secrets = readSecretsEnv();

  return json({
    ...state,
    serviceInstances: getConfiguredServiceInstances(),
    openmemoryProvider: getConfiguredOpenmemoryProvider(),
    smallModelProvider: getConfiguredSmallModel(),
    anthropicKeyConfigured: Boolean(secrets.ANTHROPIC_API_KEY),
    firstBoot: setupManager.isFirstBoot(),
  });
};
