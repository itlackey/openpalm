import { u as unauthorizedJson, j as json, e as errorJson } from "../../../../chunks/json.js";
import { g as getStackManager } from "../../../../chunks/init.js";
import { s as stringifyStackSpec, p as parseStackSpec } from "../../../../chunks/stack-spec.js";
const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const spec = stackManager.getSpec();
  return json(200, { ok: true, spec, yaml: stringifyStackSpec(spec) });
};
const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  const body = await request.json();
  const raw = body.yaml ? Bun.YAML.parse(body.yaml) : body.spec;
  if (!raw) return json(400, { error: "spec or yaml is required" });
  const parsed = parseStackSpec(raw);
  const secretErrors = stackManager.validateReferencedSecrets(parsed);
  if (secretErrors.length > 0) {
    return errorJson(400, "secret_reference_validation_failed", secretErrors);
  }
  const spec = stackManager.setSpec(parsed);
  return json(200, { ok: true, spec, yaml: stringifyStackSpec(spec) });
};
export {
  GET,
  POST
};
