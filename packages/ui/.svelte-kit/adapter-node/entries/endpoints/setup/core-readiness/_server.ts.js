import { u as unauthorizedJson, j as json } from "../../../../chunks/json.js";
import { a as getSetupManager } from "../../../../chunks/init.js";
import { i as isLocalRequest } from "../../../../chunks/auth.js";
import { getCoreReadinessSnapshot } from "../../../../chunks/core-readiness-state.js";
const GET = async ({ locals, request }) => {
  const setupManager = await getSetupManager();
  const state = setupManager.getState();
  if (state.completed === true && !locals.authenticated) return unauthorizedJson();
  if (!state.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  const snapshot = getCoreReadinessSnapshot();
  if (!snapshot) {
    return json(200, { ok: true, phase: "idle", snapshot: null });
  }
  return json(200, { ok: true, ...snapshot });
};
export {
  GET
};
