import { json } from "@sveltejs/kit";
import { resolveSetupOpencodeTarget } from "$lib/server/opencode/setup-target.js";
import type { RequestHandler } from "./$types";

// W1: reachability is resolved the same way the provider catalog resolves its
// target — the deployed assistant when it's actually up, else the
// wizard-spawned instance `POST /api/setup/opencode/ensure` started. Using
// `getOpenCodeClient()` (bound only to the deployed assistant) reported
// `available:false` on a fresh host even after `ensure` had a working
// instance running.
export const GET: RequestHandler = async () => {
  const target = await resolveSetupOpencodeTarget();
  return json({ ok: true, available: target !== null });
};
