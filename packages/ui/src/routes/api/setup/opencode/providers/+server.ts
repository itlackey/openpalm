import { json } from "@sveltejs/kit";
import { loadSetupProviderPage } from '$lib/server/opencode/catalog.js';
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  return json({ ok: true, ...(await loadSetupProviderPage()) });
};
