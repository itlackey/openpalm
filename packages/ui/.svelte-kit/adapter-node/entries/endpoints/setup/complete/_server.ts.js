import { u as unauthorizedJson, j as json, e as errorJson } from "../../../../chunks/json.js";
import { a as getSetupManager, g as getStackManager } from "../../../../chunks/init.js";
import { i as isLocalRequest } from "../../../../chunks/auth.js";
import { a as completeSetupRouteResponse } from "../../../../chunks/setup-completion-response.js";
import { S as SECRETS_ENV_PATH } from "../../../../chunks/config.js";
const POST = async ({ locals, request }) => {
  const setupManager = await getSetupManager();
  const stackManager = await getStackManager();
  const current = setupManager.getState();
  if (current.completed === true && !locals.authenticated) return unauthorizedJson();
  if (!current.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  try {
    return json(200, await completeSetupRouteResponse(setupManager, stackManager, SECRETS_ENV_PATH));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("secret_validation_failed:")) {
      return errorJson(
        400,
        "secret_reference_validation_failed",
        message.replace("secret_validation_failed:", "").split(",")
      );
    }
    return errorJson(500, "setup_complete_failed", message);
  }
};
export {
  POST
};
