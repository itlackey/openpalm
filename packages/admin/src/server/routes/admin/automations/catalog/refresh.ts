/**
 * Bun.serve handler for /admin/automations/catalog/refresh
 * Delegates to the existing SvelteKit handler via RequestEvent shim.
 * Phase 2: handler added alongside SvelteKit +server.ts (both coexist until Phase 3).
 */
import { addRoute } from "../../router.js";
import { makeEvent } from "../../shim.js";
import * as svelteHandlers from "../../../../../routes/admin/automations/catalog/refresh/+server.js";

addRoute("/admin/automations/catalog/refresh", {
  async POST(req: Request, params: Record<string, string>): Promise<Response> {
    const event = makeEvent(req, params);
    return svelteHandlers.POST(event as never);
  },
});
