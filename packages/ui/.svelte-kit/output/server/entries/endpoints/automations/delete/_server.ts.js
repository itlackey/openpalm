import { u as unauthorizedJson, j as json } from "../../../../chunks/json.js";
import { g as getStackManager } from "../../../../chunks/init.js";
import { syncAutomations } from "../../../../chunks/automations.js";
const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const body = await request.json();
  if (!body.id) return json(400, { error: "id is required" });
  try {
    const deleted = stackManager.deleteAutomation(body.id);
    if (!deleted) return json(404, { error: "automation not found" });
    syncAutomations(stackManager.listAutomations());
    return json(200, { ok: true, deleted: body.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "cannot_delete_core_automation")
      return json(400, { error: message });
    throw error;
  }
};
export {
  POST
};
