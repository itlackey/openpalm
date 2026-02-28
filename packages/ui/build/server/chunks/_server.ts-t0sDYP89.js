import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { a as getStackManager } from './init-C6nnJEAN.js';
import { triggerAutomation } from './automations-CANimQTD.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import 'node:child_process';
import './cron-Dh4kQz92.js';

const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const body = await request.json();
  if (!body.id) return json(400, { error: "id is required" });
  if (!stackManager.getAutomation(body.id))
    return json(404, { error: "automation not found" });
  const result = await triggerAutomation(body.id);
  return json(200, { triggered: body.id, ...result });
};

export { POST };
//# sourceMappingURL=_server.ts-t0sDYP89.js.map
