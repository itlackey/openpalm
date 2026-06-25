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
    if (result.status !== "ok") return json({ ok: false, ...result }, { status: 502 });
    return json({ ok: true, ...result });
  } catch (err) {
    return json({ ok: false, error: "model_fetch_failed", message: String(err) }, { status: 500 });
  }
};
