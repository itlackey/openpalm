/**
 * Bun.serve handler for /admin/auth/logout
 * Delegates to the existing SvelteKit handler via RequestEvent shim.
 * Phase 2: handler added alongside SvelteKit +server.ts (both coexist until Phase 3).
 */
import { addRoute } from "../../router.js";
import { makeEvent } from "../../shim.js";
import * as svelteHandlers from "../../../../routes/admin/auth/logout/+server.js";

addRoute("/admin/auth/logout", {
  async POST(req: Request, params: Record<string, string>): Promise<Response> {
    const event = makeEvent(req, params);
    return svelteHandlers.POST(event as never);
  },
});
