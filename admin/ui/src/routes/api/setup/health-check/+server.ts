import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { GATEWAY_URL, OPENCODE_CORE_URL, CONTROLLER_URL, OPENMEMORY_URL } from '$lib/server/env';
import {
  checkServiceHealth,
  getConfiguredServiceInstances,
} from '$lib/server/helpers';

export const GET: RequestHandler = async () => {
  const serviceInstances = getConfiguredServiceInstances();
  const openmemoryBaseUrl = serviceInstances.openmemory || OPENMEMORY_URL;

  const [gateway, controller, opencodeCore, openmemory] = await Promise.all([
    checkServiceHealth(`${GATEWAY_URL}/health`),
    CONTROLLER_URL
      ? checkServiceHealth(`${CONTROLLER_URL}/health`)
      : Promise.resolve({ ok: false, error: "not configured" } as const),
    checkServiceHealth(`${OPENCODE_CORE_URL}/`, false),
    checkServiceHealth(`${openmemoryBaseUrl}/api/v1/config/`),
  ]);

  return json({
    services: {
      gateway,
      controller,
      opencodeCore,
      openmemory,
      admin: { ok: true, time: new Date().toISOString() },
    },
    serviceInstances,
  });
};
