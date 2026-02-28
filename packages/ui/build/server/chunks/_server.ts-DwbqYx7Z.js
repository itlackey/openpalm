import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { k as knownServices } from './init-C6nnJEAN.js';
import { composeAction } from './compose-runner-BT0hCcoV.js';
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
  const body = await request.json();
  if (!body.service || !(await knownServices()).has(body.service))
    return json(400, { error: "unknown service name" });
  await composeAction("up", body.service);
  return json(200, { ok: true, action: "up", service: body.service });
};

export { POST };
//# sourceMappingURL=_server.ts-DwbqYx7Z.js.map
