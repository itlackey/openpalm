import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { a as getStackManager } from './init-C6nnJEAN.js';
import { getLatestRun } from './automation-history-CctHM2Up.js';
import { v as validateCron } from './cron-Dh4kQz92.js';
import { syncAutomations } from './automations-CANimQTD.js';
import { randomUUID } from 'node:crypto';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import 'node:child_process';

const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const automations = stackManager.listAutomations().map((automation) => ({
    ...automation,
    lastRun: getLatestRun(automation.id)
  }));
  return json(200, { automations });
};
const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const body = await request.json();
  if (!body.name || !body.schedule || !body.script) {
    return json(400, { error: "name, schedule, and script are required" });
  }
  const cronError = validateCron(body.schedule);
  if (cronError) return json(400, { error: `invalid cron expression: ${cronError}` });
  const automation = stackManager.upsertAutomation({
    id: randomUUID(),
    name: body.name,
    schedule: body.schedule,
    script: body.script,
    enabled: body.enabled ?? true
  });
  syncAutomations(stackManager.listAutomations());
  return json(201, { ok: true, automation });
};

export { GET, POST };
//# sourceMappingURL=_server.ts-BB9bJZZ9.js.map
