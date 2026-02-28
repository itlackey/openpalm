import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { a as getStackManager } from './init-C6nnJEAN.js';
import { d as readSecretsRaw, v as validateSecretsRawContent, w as writeSecretsRaw } from './env-helpers-B-Cb62vD.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import './runtime-env-BS_YlF-D.js';

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

export { GET, POST };
//# sourceMappingURL=_server.ts-BYunF8FS.js.map
