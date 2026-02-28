import { u as unauthorizedJson, j as json, e as errorJson } from "../../../../../chunks/json.js";
import { a as getSetupManager } from "../../../../../chunks/init.js";
import { i as isLocalRequest } from "../../../../../chunks/auth.js";
import { setCoreReadinessPhase, applyReadinessResult } from "../../../../../chunks/core-readiness-state.js";
import { ensureCoreServicesReady } from "../../../../../chunks/core-readiness.js";
import { SetupStartupServices } from "../../../../../chunks/compose-runner.js";
const POST = async ({ locals, request }) => {
  const setupManager = await getSetupManager();
  const state = setupManager.getState();
  if (state.completed === true && !locals.authenticated) return unauthorizedJson();
  if (!state.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  setCoreReadinessPhase("checking");
  try {
    const result = await ensureCoreServicesReady({
      targetServices: SetupStartupServices,
      maxAttempts: 6,
      pollIntervalMs: 2e3
    });
    const snapshot = applyReadinessResult(result);
    return json(200, { ok: true, ...snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setCoreReadinessPhase("failed");
    return errorJson(500, "readiness_check_failed", message);
  }
};
export {
  POST
};
