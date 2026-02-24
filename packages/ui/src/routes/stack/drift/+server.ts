import { json, unauthorizedJson } from "$lib/server/json";
import { composePsWithOverride } from "@openpalm/lib/admin/compose-runner";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const result = await composePsWithOverride();
  if (!result.ok) return json(500, { ok: false, error: result.stderr });
  return json(200, { ok: true, services: result.services });
};
