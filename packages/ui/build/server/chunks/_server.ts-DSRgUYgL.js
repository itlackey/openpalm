import { u as unauthorizedJson, j as json, e as errorJson } from './json-juD_ypql.js';
import { g as getSetupManager } from './init-C6nnJEAN.js';
import { i as isLocalRequest } from './auth-0WRDks2O.js';
import { setCoreReadinessPhase, applyReadinessResult } from './core-readiness-state-jzvT0zEC.js';
import { ensureCoreServicesReady } from './core-readiness-DyKdFkeb.js';
import { SetupStartupServices } from './compose-runner-BT0hCcoV.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import 'node:crypto';

const POST = async ({ locals, request }) => {
  const setupManager = await getSetupManager();
  const state = setupManager.getState();
  if (state.completed === true && !locals.authenticated) return unauthorizedJson();
  if (!state.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  setCoreReadinessPhase("checking");
  try {
    const result = await ensureCoreServicesReady({
      targetServices: SetupStartupServices,
      maxAttempts: 6,
      pollIntervalMs: 2e3
    });
    const snapshot = applyReadinessResult(result);
    return json(200, { ok: true, ...snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setCoreReadinessPhase("failed");
    return errorJson(500, "readiness_check_failed", message);
  }
};

export { POST };
//# sourceMappingURL=_server.ts-DSRgUYgL.js.map
