import { json } from "@sveltejs/kit";
import { performSetup, checkDocker, type SetupSpec } from "@openpalm/lib";
import { resetState, getState } from "$lib/server/state.js";
import { startDeploy, resetDeployState } from "$lib/server/setup-deploy.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json", message: "Request body must be valid JSON" }, { status: 400 });
  }

  let result: Awaited<ReturnType<typeof performSetup>>;
  try {
    result = await performSetup(body as SetupSpec);
  } catch (err) {
    return json({ ok: false, error: "setup_failed", message: String(err) }, { status: 500 });
  }

  if (!result.ok) {
    return json(result, { status: 400 });
  }

  // Reset state singleton so next getState() re-reads the new admin token
  resetState();
  const state = getState();

  // Kick off Docker deploy in the background (non-blocking)
  resetDeployState();
  const dockerCheck = await checkDocker();
  if (dockerCheck.ok) {
    startDeploy(state);
  }

  // Set session cookie so the user is automatically authenticated
  const headers = new Headers({ "content-type": "application/json" });
  if (state.adminToken) {
    headers.set(
      "set-cookie",
      `op_session=${state.adminToken}; Path=/; HttpOnly; SameSite=Strict`
    );
  }

  return new Response(JSON.stringify({ ok: true, dockerAvailable: dockerCheck.ok }), {
    status: 200,
    headers,
  });
};
