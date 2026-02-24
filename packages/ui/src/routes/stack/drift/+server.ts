import { json, unauthorizedJson } from "$lib/server/json";
import { getStackManager } from "$lib/server/init";
import { computeDriftReport } from "@openpalm/lib/admin/compose-runner";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const manager = await getStackManager();
  const drift = await computeDriftReport(manager.computeDriftReport());
  return json(200, { ok: true, drift });
};
