import { u as unauthorizedJson, j as json } from "../../../chunks/json.js";
import { g as getStackManager } from "../../../chunks/init.js";
import { getLatestRun } from "../../../chunks/automation-history.js";
import { v as validateCron } from "../../../chunks/cron.js";
import { syncAutomations } from "../../../chunks/automations.js";
import { randomUUID } from "node:crypto";
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
export {
  GET,
  POST
};
