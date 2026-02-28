import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { k as knownServices } from './init-C6nnJEAN.js';
import { composeLogsValidateTail, composeLogs } from './compose-runner-BT0hCcoV.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';

const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const body = await request.json();
  const service = body.service ?? "";
  const tail = typeof body.tail === "number" ? body.tail : 200;
  if (!service || !(await knownServices()).has(service))
    return json(400, { error: "unknown service name" });
  if (!composeLogsValidateTail(tail)) return json(400, { error: "invalid tail value" });
  const result = await composeLogs(service, tail);
  if (!result.ok) throw new Error(result.stderr || "service_logs_failed");
  return json(200, { ok: true, service, tail, logs: result.stdout });
};

export { POST };
//# sourceMappingURL=_server.ts-BJWQEYk6.js.map
