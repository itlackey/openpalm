import { json } from "@sveltejs/kit";
import { getOpenCodeClient } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

const PROVIDER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const POST: RequestHandler = async ({ params, request }) => {
  if (!PROVIDER_ID_RE.test(params.provider)) {
    return json({ ok: false, message: "Invalid provider" }, { status: 400 });
  }
  try {
    const body = await request.json();
    const method = Number.isInteger(body.method) ? (body.method as number) : 0;
    const code = typeof body.code === "string" ? body.code.slice(0, 1024) : undefined;
    const client = getOpenCodeClient();
    const result = await client.completeProviderOAuth(params.provider, method, code);
    if (!result.ok) return json({ ok: false, message: "OAuth callback failed" }, { status: 400 });
    return json({ ok: true, complete: result.data });
  } catch {
    return json({ ok: false, message: "OAuth callback failed" }, { status: 500 });
  }
};
