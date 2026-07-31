import { json } from "@sveltejs/kit";
import { createOpenCodeClient } from "@openpalm/lib";
import { resolveSetupOpencodeTarget } from "$lib/server/opencode/setup-target.js";
import type { RequestHandler } from "./$types";

const PROVIDER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// W2: the client (setup-state.svelte.ts) makes ONE call here and waits up to
// 10 minutes for it — this IS the long-poll. `opencode-client.ts`'s
// `completeProviderOAuth` has no way to override its own 30s default abort, so
// call the client's shared `proxy` directly (the exact request
// `completeProviderOAuth` would have made) with an explicit longer timeout.
// Kept a little under the client's 10-minute wait so a genuinely stuck
// upstream returns a real error body instead of the browser's raw abort.
const CALLBACK_TIMEOUT_MS = 9 * 60_000;

export const POST: RequestHandler = async ({ params, request }) => {
  if (!PROVIDER_ID_RE.test(params.provider)) {
    return json({ ok: false, message: "Invalid provider" }, { status: 400 });
  }
  // W1: target the wizard-spawned OpenCode when the deployed assistant isn't
  // reachable yet, instead of hardcoding the deployed-assistant target.
  const target = await resolveSetupOpencodeTarget();
  if (!target) {
    return json(
      { ok: false, message: "OpenCode is not reachable yet. Wait a moment and try again." },
      { status: 503 },
    );
  }
  try {
    const body = await request.json();
    const method = Number.isInteger(body.method) ? (body.method as number) : 0;
    // W2 (code providers): OpenCode's `method:'code'` flow needs a code the
    // user copies back from the provider's page — accepted here so a caller
    // that collected one can submit it in the same long-poll request.
    const code = typeof body.code === "string" ? body.code.slice(0, 1024) : undefined;
    const client = createOpenCodeClient({ baseUrl: target.url, username: target.username, password: target.password });
    const result = await client.proxy(
      `/provider/${encodeURIComponent(params.provider)}/oauth/callback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, ...(code ? { code } : {}) }),
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      },
    );
    if (!result.ok) return json({ ok: false, message: result.message ?? "OAuth callback failed" }, { status: 400 });
    return json({ ok: true, complete: result.data });
  } catch {
    return json({ ok: false, message: "OAuth callback failed" }, { status: 500 });
  }
};
