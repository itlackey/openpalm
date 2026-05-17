import { json } from "@sveltejs/kit";
import { getOpenCodeClient } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

const PROVIDER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const PUT: RequestHandler = async ({ params, request }) => {
  if (!PROVIDER_ID_RE.test(params.provider)) {
    return json({ ok: false, message: "Invalid provider" }, { status: 400 });
  }
  try {
    const { key } = await request.json();
    const client = getOpenCodeClient();
    const result = await client.setProviderApiKey(params.provider, typeof key === "string" ? key : "");
    if (!result.ok) return json({ ok: false, message: "Failed to set provider credentials" }, { status: 400 });
    return json({ ok: true });
  } catch {
    return json({ ok: false, message: "Failed to set provider credentials" }, { status: 500 });
  }
};
