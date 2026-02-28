import { u as unauthorizedJson, j as json, e as errorJson } from "../../../chunks/json.js";
import { g as getStackManager } from "../../../chunks/init.js";
const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  return json(200, { ok: true, ...stackManager.listSecretManagerState() });
};
const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const body = await request.json();
  try {
    const name = stackManager.upsertSecret(body.name, body.value);
    return json(200, { ok: true, name });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invalid_secret_name") return errorJson(400, message);
    throw error;
  }
};
export {
  GET,
  POST
};
