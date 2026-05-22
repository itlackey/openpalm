import { json } from "@sveltejs/kit";
import { performSetup, checkDocker, type SetupSpec } from "@openpalm/lib";
import { resetState, getState } from "$lib/server/state.js";
import { startDeploy, resetDeployState } from "$lib/server/setup-deploy.js";
import type { RequestHandler } from "./$types";

interface CompleteBody extends SetupSpec {
  /** When true, persist config but DO NOT trigger Docker deploy. Used by
   *  tests and validation flows so they cannot accidentally clobber a
   *  running stack that shares the same compose project name. */
  dryRun?: boolean;
}

export const POST: RequestHandler = async ({ request }) => {
  let body: CompleteBody;
  try {
    body = await request.json() as CompleteBody;
  } catch {
    return json({ ok: false, error: "invalid_json", message: "Request body must be valid JSON" }, { status: 400 });
  }

  const dryRun = body.dryRun === true;

  let result: Awaited<ReturnType<typeof performSetup>>;
  try {
    result = await performSetup(body);
  } catch (err) {
    return json({ ok: false, error: "setup_failed", message: String(err) }, { status: 500 });
  }

  if (!result.ok) {
    return json(result, { status: 400 });
  }

  // Reset state singleton so next getState() re-reads the new admin token
  resetState();
  const state = getState();

  // Kick off Docker deploy in the background (non-blocking) — unless the
  // caller passed dryRun:true (validation / test path).
  resetDeployState();
  let dockerCheck: Awaited<ReturnType<typeof checkDocker>> | null = null;
  if (!dryRun) {
    dockerCheck = await checkDocker();
    if (dockerCheck.ok) {
      startDeploy(state);
    }
  }

  // Set session cookie so the user is automatically authenticated
  const headers = new Headers({ "content-type": "application/json" });
  if (state.adminToken) {
    headers.set(
      "set-cookie",
      `op_session=${state.adminToken}; Path=/; HttpOnly; SameSite=Strict`
    );
  }

  return new Response(JSON.stringify({
    ok: true,
    dockerAvailable: dockerCheck?.ok ?? false,
    dryRun,
  }), {
    status: 200,
    headers,
  });
};
