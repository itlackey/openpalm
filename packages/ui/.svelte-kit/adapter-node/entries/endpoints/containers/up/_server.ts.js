import { u as unauthorizedJson, j as json } from "../../../../chunks/json.js";
import { k as knownServices } from "../../../../chunks/init.js";
import { composeAction } from "../../../../chunks/compose-runner.js";
const POST = async ({ locals, request }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const body = await request.json();
  if (!body.service || !(await knownServices()).has(body.service))
    return json(400, { error: "unknown service name" });
  await composeAction("up", body.service);
  return json(200, { ok: true, action: "up", service: body.service });
};
export {
  POST
};
