import { json } from "@sveltejs/kit";
import { fetchProviderModels, resolveOpenPalmHome } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const provider = decodeURIComponent(params.provider);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json", message: "Request body must be valid JSON" }, { status: 400 });
  }

  const apiKey  = typeof body.apiKey  === "string" ? body.apiKey  : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";

  try {
    const result = await fetchProviderModels(provider, apiKey, baseUrl, resolveOpenPalmHome());
    // `recoverable_error` (no/invalid credentials, unreachable, timeout) is an
    // EXPECTED, non-fatal outcome: the request itself succeeded, the provider
    // just isn't usable yet. Return 200 with the structured result so the wizard
    // reads `data.status` and shows it inline — a 502 here only makes the browser
    // log a hard console error for a state the client already handles. (Mirrors
    // guardian/health returning 200 `not_deployed` instead of 503-spamming the
    // console.) Genuine server faults still surface as 500 via the catch below.
    return json({ ok: result.status === "ok", ...result });
  } catch (err) {
    return json({ ok: false, error: "model_fetch_failed", message: String(err) }, { status: 500 });
  }
};
