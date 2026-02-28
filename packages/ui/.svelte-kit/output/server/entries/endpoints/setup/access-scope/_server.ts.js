import { j as json, u as unauthorizedJson } from "../../../../chunks/json.js";
import { a as getSetupManager, g as getStackManager } from "../../../../chunks/init.js";
import { s as setRuntimeBindScope } from "../../../../chunks/env-helpers.js";
import { i as isLocalRequest } from "../../../../chunks/auth.js";
const POST = async ({ locals, request }) => {
  const setupManager = await getSetupManager();
  const stackManager = await getStackManager();
  const body = await request.json();
  if (!["host", "lan", "public"].includes(body.scope))
    return json(400, { error: "invalid scope" });
  const current = setupManager.getState();
  if (current.completed && !locals.authenticated) return unauthorizedJson();
  if (!current.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  stackManager.setAccessScope(body.scope);
  await setRuntimeBindScope(body.scope);
  const state = setupManager.setAccessScope(body.scope);
  return json(200, { ok: true, state });
};
export {
  POST
};
