import { u as unauthorizedJson, j as json } from "../../../../chunks/json.js";
import { k as knownServices } from "../../../../chunks/init.js";
import { composePull, composeAction } from "../../../../chunks/compose-runner.js";
const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const body = await request.json();
  if (!body.service || !(await knownServices()).has(body.service))
    return json(400, { error: "unknown service name" });
  const pullResult = await composePull(body.service);
  if (!pullResult.ok) throw new Error(pullResult.stderr || "service_pull_failed");
  await composeAction("up", body.service);
  return json(200, { ok: true, action: "update", service: body.service });
};
export {
  POST
};
