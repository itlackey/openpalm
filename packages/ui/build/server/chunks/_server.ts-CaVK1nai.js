import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { a as getStackManager } from './init-C6nnJEAN.js';
import { v as validateCron } from './cron-Dh4kQz92.js';
import { syncAutomations } from './automations-CANimQTD.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import 'node:child_process';

const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const body = await request.json();
  if (!body.id) return json(400, { error: "id is required" });
  const existing = stackManager.getAutomation(body.id);
  if (!existing) return json(404, { error: "automation not found" });
  const updated = { ...existing, ...body, id: existing.id };
  const cronError = validateCron(updated.schedule);
  if (cronError) return json(400, { error: `invalid cron expression: ${cronError}` });
  const automation = stackManager.upsertAutomation(updated);
  syncAutomations(stackManager.listAutomations());
  return json(200, { ok: true, automation });
};

export { POST };
//# sourceMappingURL=_server.ts-CaVK1nai.js.map
