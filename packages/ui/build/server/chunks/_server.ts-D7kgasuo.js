import { u as unauthorizedJson, j as json, e as errorJson } from './json-juD_ypql.js';
import { a as getStackManager } from './init-C6nnJEAN.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';

const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const body = await request.json();
  try {
    const deleted = stackManager.deleteSecret(body.name);
    return json(200, { ok: true, deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invalid_secret_name" || message === "secret_in_use")
      return errorJson(400, message);
    throw error;
  }
};

export { POST };
//# sourceMappingURL=_server.ts-D7kgasuo.js.map
