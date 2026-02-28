import { u as unauthorizedJson, j as json, e as errorJson } from './json-juD_ypql.js';
import { g as getSetupManager, a as getStackManager } from './init-C6nnJEAN.js';
import { i as isLocalRequest } from './auth-0WRDks2O.js';
import { a as completeSetupRouteResponse } from './setup-completion-response-FQQRRQU1.js';
import { S as SECRETS_ENV_PATH } from './config-B06wMz0z.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import 'node:crypto';
import './stack-apply-engine-CX7GxTsE.js';
import './compose-runner-BT0hCcoV.js';
import './runtime-env-BS_YlF-D.js';
import './core-readiness-DyKdFkeb.js';
import './automations-CANimQTD.js';
import 'node:child_process';
import './cron-Dh4kQz92.js';
import './core-readiness-state-jzvT0zEC.js';
import './shared-server-DaWdgxVh.js';

const POST = async ({ locals, request }) => {
  const setupManager = await getSetupManager();
  const stackManager = await getStackManager();
  const current = setupManager.getState();
  if (current.completed === true && !locals.authenticated) return unauthorizedJson();
  if (!current.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  try {
    return json(200, await completeSetupRouteResponse(setupManager, stackManager, SECRETS_ENV_PATH));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("secret_validation_failed:")) {
      return errorJson(
        400,
        "secret_reference_validation_failed",
        message.replace("secret_validation_failed:", "").split(",")
      );
    }
    return errorJson(500, "setup_complete_failed", message);
  }
};

export { POST };
//# sourceMappingURL=_server.ts-B3897sWt.js.map
