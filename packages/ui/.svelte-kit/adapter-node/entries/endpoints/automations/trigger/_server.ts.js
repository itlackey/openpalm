import { u as unauthorizedJson, j as json } from "../../../../chunks/json.js";
import { g as getStackManager } from "../../../../chunks/init.js";
import { triggerAutomation } from "../../../../chunks/automations.js";
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
export {
  POST
};
