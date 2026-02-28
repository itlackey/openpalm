import { u as unauthorizedJson, j as json } from "../../../../chunks/json.js";
import { a as getSetupManager } from "../../../../chunks/init.js";
import { i as isLocalRequest } from "../../../../chunks/auth.js";
const POST = async ({ locals, request }) => {
  const setupManager = await getSetupManager();
  const current = setupManager.getState();
  if (current.completed && !locals.authenticated) return unauthorizedJson();
  if (!current.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  const body = await request.json();
  const validSteps = [
    "welcome",
    "profile",
    "accessScope",
    "serviceInstances",
    "healthCheck",
    "security",
    "channels"
  ];
  if (!validSteps.includes(body.step)) return json(400, { error: "invalid step" });
  const state = setupManager.completeStep(
    body.step
  );
  return json(200, { ok: true, state });
};
export {
  POST
};
