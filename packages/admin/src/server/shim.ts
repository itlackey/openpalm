/**
 * Minimal RequestEvent shim for bridging Bun.serve Request objects
 * to SvelteKit handler functions.
 *
 * Phase 2: Bun handlers delegate to the existing SvelteKit handler logic
 * via this shim so the route business logic lives in one place.
 * Phase 3: The SvelteKit handlers are removed and Bun handlers become the source.
 */
import type { RequestEvent } from "@sveltejs/kit";

/**
 * Wrap a plain Request and route params in a minimal RequestEvent-compatible shim.
 * Only the fields used by the SvelteKit helpers and routes are populated.
 */
export function makeEvent(
  req: Request,
  params: Record<string, string> = {}
): RequestEvent {
  return {
    request: req,
    params,
    url: new URL(req.url),
    route: { id: null },
    isDataRequest: false,
    isSubRequest: false,
    cookies: {
      get: () => undefined,
      getAll: () => [],
      set: () => {},
      delete: () => {},
      serialize: () => "",
    },
    fetch: globalThis.fetch,
    getClientAddress: () => "unknown",
    locals: {},
    platform: {},
    setHeaders: () => {},
  } as unknown as RequestEvent;
}
