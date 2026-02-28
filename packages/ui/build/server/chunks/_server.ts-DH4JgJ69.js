import { j as json, u as unauthorizedJson } from './json-juD_ypql.js';
import { g as getSetupManager, a as getStackManager } from './init-C6nnJEAN.js';
import { s as setRuntimeBindScope } from './env-helpers-B-Cb62vD.js';
import { i as isLocalRequest } from './auth-0WRDks2O.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import './runtime-env-BS_YlF-D.js';
import 'node:crypto';

const POST = async ({ locals, request }) => {
  const setupManager = await getSetupManager();
  const stackManager = await getStackManager();
  const body = await request.json();
  if (!["host", "lan", "public"].includes(body.scope))
    return json(400, { error: "invalid scope" });
  const current = setupManager.getState();
  if (current.completed && !locals.authenticated) return unauthorizedJson();
  if (!current.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  stackManager.setAccessScope(body.scope);
  await setRuntimeBindScope(body.scope);
  const state = setupManager.setAccessScope(body.scope);
  return json(200, { ok: true, state });
};

export { POST };
//# sourceMappingURL=_server.ts-DH4JgJ69.js.map
