import { json } from "@sveltejs/kit";
import { getOpenCodeClient } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  try {
    const client = getOpenCodeClient();
    const available = await client.isAvailable();
    if (!available) return json({ ok: true, available: false, providers: [] });
    const [providers, auth] = await Promise.all([
      client.getProviders(),
      client.getProviderAuth(),
    ]);
    return json({ ok: true, available: true, providers, auth });
  } catch {
    return json({ ok: true, available: false, providers: [] });
  }
};
