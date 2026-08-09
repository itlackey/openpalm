import { json } from "@sveltejs/kit";
import {
  createOpenCodeClient,
  createState,
  persistHostOpenCodeOAuthCredential,
} from "@openpalm/lib";
import { resolveSetupOpencodeTarget } from "$lib/server/opencode/setup-target.js";
import type { SetupOpencodeSource } from "$lib/server/opencode/setup-target.js";
import { errorResponse, getRequestId } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

const PROVIDER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// W2: the client (setup-state.svelte.ts) makes ONE call here and waits up to
// 10 minutes for it — this IS the long-poll. `completeProviderOAuth` accepts
// an explicit timeout for exactly this case. Kept a little under the
// client's 10-minute wait so a genuinely stuck upstream returns a real error
// body instead of the browser's raw abort.
const CALLBACK_TIMEOUT_MS = 9 * 60_000;

function isSetupOpencodeSource(value: unknown): value is SetupOpencodeSource {
  return value === "wizard" || value === "assistant";
}

export const POST: RequestHandler = async (event) => {
  const { params, request } = event;
  const requestId = getRequestId(event);
  if (!PROVIDER_ID_RE.test(params.provider)) {
    return errorResponse(400, "invalid_provider", "Invalid provider", {}, requestId);
  }
  try {
    const body = await request.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(400, "invalid_request", "Invalid OAuth callback request", {}, requestId);
    }
    const input = body as Record<string, unknown>;
    if (!isSetupOpencodeSource(input.source)) {
      return errorResponse(400, "invalid_oauth_source", "Invalid OAuth target source", {}, requestId);
    }
    const source = input.source;
    // Resolve only the source selected by authorize. In particular, do not
    // switch to the assistant if it becomes healthy during a wizard flow.
    const target = await resolveSetupOpencodeTarget(source);
    if (!target) {
      return errorResponse(503, "opencode_unavailable", "The OpenCode instance used for authorization is no longer reachable.", {}, requestId);
    }
    const method = Number.isInteger(input.method) ? (input.method as number) : 0;
    // W2 (code providers): OpenCode's `method:'code'` flow needs a code the
    // user copies back from the provider's page — accepted here so a caller
    // that collected one can submit it in the same long-poll request.
    const code = typeof input.code === "string" ? input.code.slice(0, 1024) : undefined;
    const client = createOpenCodeClient({ baseUrl: target.url, username: target.username, password: target.password });
    // Honor an abort only while it can still matter — BEFORE the completion
    // call. Once completeProviderOAuth resolves ok the provider has consumed
    // the one-time code, so an abort that races completion must not turn that
    // success into a 400: the wizard would retry an already-dead code.
    if (request.signal.aborted) {
      return errorResponse(400, "oauth_callback_aborted", "OAuth callback was cancelled", {}, requestId);
    }
    const result = await client.completeProviderOAuth(params.provider, method, code, {
      timeoutMs: CALLBACK_TIMEOUT_MS,
      signal: request.signal,
    });
    if (!result.ok) return errorResponse(400, "oauth_callback_failed", result.message ?? "OAuth callback failed", {}, requestId);
    // A wizard-spawned OpenCode writes OAuth state to the host OpenCode store,
    // not OP_HOME. Persist only the provider this callback completed. A healthy
    // deployed assistant already writes canonical auth.json directly and must
    // never trigger a redundant host import.
    if (source === "wizard") {
      try {
        persistHostOpenCodeOAuthCredential(createState(), params.provider);
      } catch (e) {
        // OAuth itself SUCCEEDED (the one-time code is consumed) — only the
        // credential import failed. A generic oauth_callback_failed here would
        // send the wizard back to retry a code the provider no longer accepts.
        return errorResponse(500, "oauth_credential_import_failed", `OAuth completed but importing the credential failed: ${e instanceof Error ? e.message : String(e)}`, {}, requestId);
      }
    }
    return json({ ok: true, complete: result.data });
  } catch {
    return errorResponse(500, "oauth_callback_failed", "OAuth callback failed", {}, requestId);
  }
};
