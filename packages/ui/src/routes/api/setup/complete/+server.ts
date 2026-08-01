import { performSetup, checkDocker, mapDockerError, reconcileMdnsResponder, type SetupSpec } from "@openpalm/lib";
import { resetState, getState } from "$lib/server/state.js";
import { prepareSetupRestorePoint, startDeploy, resetDeployState } from "$lib/server/setup-deploy.js";
import { getUiLoginPassword, requireAdmin, getRequestId, errorResponse } from "$lib/server/helpers.js";
import { isSetupComplete, resolveOpenPalmHome } from "@openpalm/lib";
import { createSession } from "$lib/server/session-store.js";
import { sessionCookieHeader } from "$lib/server/session-cookie.js";
import type { RequestHandler } from "./$types";

interface CompleteBody extends SetupSpec {
  /** When true, persist config but DO NOT trigger Docker deploy. Used by
   *  tests and validation flows so they cannot accidentally clobber a
   *  running stack that shares the same compose project name. */
  dryRun?: boolean;
}

export const POST: RequestHandler = async (event) => {
  // W15: computed unconditionally (not just inside the admin-check branch
  // below) so every error response from this route — not only the auth
  // failure — carries the same requestId the rest of the app's error
  // envelope uses.
  const requestId = getRequestId(event);

  // S2: Once setup is complete, re-running it is an admin-only action.
  if (isSetupComplete(resolveOpenPalmHome())) {
    const authError = requireAdmin(event, requestId);
    if (authError) return authError;
  }

  const { request } = event;
  let body: CompleteBody;
  try {
    body = await request.json() as CompleteBody;
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON", {}, requestId);
  }

  const dryRun = body.dryRun === true;

  let result: Awaited<ReturnType<typeof performSetup>>;
  try {
    prepareSetupRestorePoint(getState());
    result = await performSetup(body);
  } catch (err) {
    const mapped = mapDockerError(String(err));
    return errorResponse(500, mapped.code, mapped.message, {}, requestId);
  }

  if (!result.ok) {
    // performSetup's own failure shape is `{ ok: false, error: <human text> }`
    // (validation errors, persistence failures) — `error` there is prose, not
    // a machine code. Wrap it in the standard envelope instead of returning
    // the lib's shape verbatim so every /api/setup/* failure looks the same
    // on the wire; `completeSetup()` (setup-api.ts) already reads
    // `message ?? error`, so this is a pure addition for existing callers.
    return errorResponse(400, "setup_invalid", result.error ?? "Setup failed.", {}, requestId);
  }

  // Reset state singleton so next getState() re-reads fresh paths.
  resetState();
  const state = getState();

  // PR #564 second retest P1-4: an explicit UI-password rotation persists the new
  // value to the secret file, but hooks.server.ts promoted the OLD value into
  // process.env.OP_UI_LOGIN_PASSWORD at startup and getUiLoginPassword() reads env
  // FIRST — so without this the running server keeps accepting the old password
  // (old=200, new=401) until a restart. Sync the live env to the freshly-set
  // password so the rotation takes effect immediately: getUiLoginPassword(), the
  // session-token signer, and login verification all pick up the new value.
  if (typeof body.security?.uiLoginPassword === "string" && body.security.uiLoginPassword) {
    process.env.OP_UI_LOGIN_PASSWORD = body.security.uiLoginPassword;
  }

  // #563 — synchronous, non-throwing, and gated (same call the host/stack PUT
  // makes): a network access preset that changed the bind vars flips mDNS
  // advertisement immediately, without waiting for a host-process restart.
  reconcileMdnsResponder(state.homeDir);

  // Kick off Docker deploy in the background (non-blocking) — unless the
  // caller passed dryRun:true (validation / test path).
  resetDeployState();
  let dockerCheck: Awaited<ReturnType<typeof checkDocker>> | null = null;
  if (!dryRun) {
    dockerCheck = await checkDocker();
    if (dockerCheck.ok) {
      startDeploy(state);
    } else {
      // Docker is down. Config was persisted successfully, but we cannot
      // deploy. Returning ok:true here used to leave the client polling the
      // deploy state forever (it never starts). Surface a structured,
      // actionable error instead (#464).
      return errorResponse(
        503,
        "docker_unavailable",
        "Docker isn't running. Start Docker Desktop or OrbStack, then try again.",
        {},
        requestId,
      );
    }
  }

  // Set session cookie so the user is automatically authenticated after install.
  // The cookie value is an opaque session token (not the plaintext password).
  const headers = new Headers({ "content-type": "application/json" });
  const hasPassword =
    (typeof body.security?.uiLoginPassword === "string" && body.security.uiLoginPassword) ||
    getUiLoginPassword();
  if (hasPassword) {
    const sessionToken = createSession();
    headers.set("set-cookie", sessionCookieHeader(sessionToken, event.request));
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
