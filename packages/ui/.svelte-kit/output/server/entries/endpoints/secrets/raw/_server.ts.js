import { u as unauthorizedJson, j as json } from "../../../../chunks/json.js";
import { g as getStackManager } from "../../../../chunks/init.js";
import { d as readSecretsRaw, v as validateSecretsRawContent, w as writeSecretsRaw } from "../../../../chunks/env-helpers.js";
const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const content = readSecretsRaw();
  return new Response(content, {
    headers: {
      "content-type": "text/plain",
      "cache-control": "no-store, no-cache, must-revalidate",
      "x-content-type-options": "nosniff",
      pragma: "no-cache"
    }
  });
};
const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const body = await request.json();
  if (typeof body.content !== "string") return json(400, { error: "content is required" });
  const validationError = validateSecretsRawContent(body.content);
  if (validationError) return json(400, { error: validationError });
  writeSecretsRaw(body.content);
  stackManager.renderArtifacts();
  return json(200, { ok: true });
};
export {
  GET,
  POST
};
