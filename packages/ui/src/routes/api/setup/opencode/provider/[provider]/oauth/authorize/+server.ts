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
    const client = getOpenCodeClient();
    const result = await client.startProviderOAuth(params.provider, method);
    if (!result.ok) return json({ ok: false, message: "OAuth authorization failed" }, { status: 400 });
    return json({ ok: true, ...(result.data as object) });
  } catch {
    return json({ ok: false, message: "OAuth authorization failed" }, { status: 500 });
  }
};
