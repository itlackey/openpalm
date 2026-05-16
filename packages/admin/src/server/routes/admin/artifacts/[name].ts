/**
 * Bun.serve handler for /admin/artifacts/[name]
 * Delegates to the existing SvelteKit handler via RequestEvent shim.
 * Phase 2: handler added alongside SvelteKit +server.ts (both coexist until Phase 3).
 */
import { addRoute } from "../../router.js";
import { makeEvent } from "../../shim.js";
import * as svelteHandlers from "../../../../routes/admin/artifacts/[name]/+server.js";

addRoute("/admin/artifacts/[name]", {
  async GET(req: Request, params: Record<string, string>): Promise<Response> {
    const event = makeEvent(req, params);
    return svelteHandlers.GET(event as never);
  },
});
