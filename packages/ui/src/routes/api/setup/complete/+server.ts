import { json } from "@sveltejs/kit";
import { performSetup, checkDocker, type SetupSpec } from "@openpalm/lib";
import { resetState, getState } from "$lib/server/state.js";
import { startDeploy, resetDeployState } from "$lib/server/setup-deploy.js";
import { getUiLoginPassword, requireAdmin, getRequestId, errorResponse } from "$lib/server/helpers.js";
import { isSetupComplete, resolveStackDir } from "@openpalm/lib";
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
  // S2: Once setup is complete, re-running it is an admin-only action.
  if (isSetupComplete(resolveStackDir())) {
    const requestId = getRequestId(event);
    const authError = requireAdmin(event, requestId);
    if (authError) return authError;
  }

  const { request } = event;
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
    const msg = String(err);
    // Map common syscall errors to stable, structured error codes so the
    // wizard's friendly-error layer can match them by string.
    if (/ENOSPC/i.test(msg)) {
      return json(
        { ok: false, error: "no_space", message: "Your disk is full. Free up some space and try again." },
        { status: 500 }
      );
    }
    if (/EACCES|EPERM/i.test(msg)) {
      return json(
        {
          ok: false,
          error: "permission_denied",
          message: "OpenPalm couldn't write to ~/.openpalm. Check that your user owns that directory.",
        },
        { status: 500 }
      );
    }
    if (/ENOTDIR|EISDIR/i.test(msg)) {
      return json(
        { ok: false, error: "bad_path", message: "An OpenPalm config path is wrong. Try a fresh install." },
        { status: 500 }
      );
    }
    return json({ ok: false, error: "setup_failed", message: msg }, { status: 500 });
  }

  if (!result.ok) {
    return json(result, { status: 400 });
  }

  // Reset state singleton so next getState() re-reads fresh paths.
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
    } else {
      // Docker is down. Config was persisted successfully, but we cannot
      // deploy. Returning ok:true here used to leave the client polling the
      // deploy state forever (it never starts). Surface a structured,
      // actionable error instead (#464).
      return json(
        {
          ok: false,
          error: "docker_unavailable",
          message:
            "Docker isn't running. Start Docker Desktop or OrbStack, then try again.",
        },
        { status: 503, headers: { "content-type": "application/json" } }
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
