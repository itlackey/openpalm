import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { g as getSetupManager } from './init-C6nnJEAN.js';
import { i as isLocalRequest } from './auth-0WRDks2O.js';
import { getCoreReadinessSnapshot } from './core-readiness-state-jzvT0zEC.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import 'node:crypto';

const GET = async ({ locals, request }) => {
  const setupManager = await getSetupManager();
  const state = setupManager.getState();
  if (state.completed === true && !locals.authenticated) return unauthorizedJson();
  if (!state.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  const snapshot = getCoreReadinessSnapshot();
  if (!snapshot) {
    return json(200, { ok: true, phase: "idle", snapshot: null });
  }
  return json(200, { ok: true, ...snapshot });
};

export { GET };
//# sourceMappingURL=_server.ts-BFkMtlwL.js.map
