import { u as unauthorizedJson, j as json } from "../../../../chunks/json.js";
import { composePs } from "../../../../chunks/compose-runner.js";
const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const result = await composePs();
  if (!result.ok) return json(500, { ok: false, error: result.stderr });
  return json(200, { ok: true, services: result.services });
};
export {
  GET
};
