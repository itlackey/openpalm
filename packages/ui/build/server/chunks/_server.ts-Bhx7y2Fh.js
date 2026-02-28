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

const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  return json(200, { ok: true, ...stackManager.listSecretManagerState() });
};
const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const body = await request.json();
  try {
    const name = stackManager.upsertSecret(body.name, body.value);
    return json(200, { ok: true, name });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invalid_secret_name") return errorJson(400, message);
    throw error;
  }
};

export { GET, POST };
//# sourceMappingURL=_server.ts-Bhx7y2Fh.js.map
