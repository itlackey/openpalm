import { u as unauthorizedJson, j as json } from "../../../../chunks/json.js";
import { g as getStackManager } from "../../../../chunks/init.js";
import { v as validateCron } from "../../../../chunks/cron.js";
import { syncAutomations } from "../../../../chunks/automations.js";
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
export {
  POST
};
