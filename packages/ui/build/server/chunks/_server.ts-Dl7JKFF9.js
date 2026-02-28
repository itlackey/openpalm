import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { g as getSetupManager } from './init-C6nnJEAN.js';
import { i as isLocalRequest } from './auth-0WRDks2O.js';
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
  const current = setupManager.getState();
  if (current.completed && !locals.authenticated) return unauthorizedJson();
  if (!current.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  const body = await request.json();
  const validSteps = [
    "welcome",
    "profile",
    "accessScope",
    "serviceInstances",
    "healthCheck",
    "security",
    "channels"
  ];
  if (!validSteps.includes(body.step)) return json(400, { error: "invalid step" });
  const state = setupManager.completeStep(
    body.step
  );
  return json(200, { ok: true, state });
};

export { POST };
//# sourceMappingURL=_server.ts-Dl7JKFF9.js.map
