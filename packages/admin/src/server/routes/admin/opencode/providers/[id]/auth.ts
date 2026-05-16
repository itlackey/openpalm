/**
 * Bun.serve handler for /admin/opencode/providers/[id]/auth
 * Delegates to the existing SvelteKit handler via RequestEvent shim.
 * Phase 2: handler added alongside SvelteKit +server.ts (both coexist until Phase 3).
 */
import { addRoute } from "../../router.js";
import { makeEvent } from "../../shim.js";
import * as svelteHandlers from "../../../../../../routes/admin/opencode/providers/[id]/auth/+server.js";

addRoute("/admin/opencode/providers/[id]/auth", {
  async GET(req: Request, params: Record<string, string>): Promise<Response> {
    const event = makeEvent(req, params);
    return svelteHandlers.GET(event as never);
  },
  async POST(req: Request, params: Record<string, string>): Promise<Response> {
    const event = makeEvent(req, params);
    return svelteHandlers.POST(event as never);
  },
});
