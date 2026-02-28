import { u as unauthorizedJson, j as json } from "../../../../chunks/json.js";
import { k as knownServices } from "../../../../chunks/init.js";
import { composeLogsValidateTail, composeLogs } from "../../../../chunks/compose-runner.js";
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
export {
  POST
};
