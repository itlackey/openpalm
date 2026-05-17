import { json } from "@sveltejs/kit";
import { getOpenCodeClient } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  try {
    const available = await getOpenCodeClient().isAvailable();
    return json({ ok: true, available });
  } catch {
    return json({ ok: true, available: false });
  }
};
