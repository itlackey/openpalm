import { u as unauthorizedJson, j as json, e as errorJson } from "../../../../chunks/json.js";
import { g as getStackManager } from "../../../../chunks/init.js";
const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const body = await request.json();
  try {
    const deleted = stackManager.deleteSecret(body.name);
    return json(200, { ok: true, deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invalid_secret_name" || message === "secret_in_use")
      return errorJson(400, message);
    throw error;
  }
};
export {
  POST
};
