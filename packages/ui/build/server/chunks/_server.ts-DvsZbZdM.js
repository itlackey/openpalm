import { u as unauthorizedJson, j as json, e as errorJson } from './json-juD_ypql.js';
import { a as getStackManager } from './init-C6nnJEAN.js';
import { s as stringifyStackSpec, p as parseStackSpec } from './stack-spec-DIyG4On0.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import './index-CyXiysyI.js';
import 'node:fs';
import 'node:path';

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

export { GET, POST };
//# sourceMappingURL=_server.ts-DvsZbZdM.js.map
