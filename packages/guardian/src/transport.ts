/**
 * Direct-listener transport seam.
 *
 * The guardian's direct ingress (port {@link GUARDIAN_DIRECT_PORT}, default
 * 3830) serves a fixed set of built-in routes (`/oc`, and `/mcp` when
 * `GUARDIAN_MCP=true`). A *transport* is an additive route handler plugged onto
 * that same listener so downstream distributions can offer extra protocols
 * (e.g. A2A) WITHOUT forking `server.ts`.
 *
 * Public OpenPalm registers no transports; the registry is the seam, not a
 * feature. Register before {@link startGuardian} runs:
 *
 * ```ts
 * import { registerTransport, startGuardian } from '@openpalm/guardian';
 * registerTransport(myA2aTransport);
 * startGuardian();
 * ```
 */

/** A request handler plugged onto the guardian direct listener. */
export interface Transport {
  /** Stable identifier, used in request counters / diagnostics (e.g. `"a2a"`). */
  name: string;
  /**
   * Optional env-var gate. When set, the transport is only consulted while
   * `Bun.env[enabledEnv] === 'true'` — mirroring how `/mcp` is gated by
   * `GUARDIAN_MCP`. Omit for an always-on transport.
   */
  enabledEnv?: string;
  /** Return true if this transport claims the request. */
  matches(url: URL, req: Request): boolean;
  /** Handle a claimed request. Performs its own authentication/authorization. */
  handle(req: Request, requestId: string): Promise<Response>;
}

const transports: Transport[] = [];

/** Register an additive direct-listener transport. Throws on a duplicate name. */
export function registerTransport(transport: Transport): void {
  if (transports.some((t) => t.name === transport.name)) {
    throw new Error(`transport already registered: ${transport.name}`);
  }
  transports.push(transport);
}

/** All registered transports, in registration order. */
export function registeredTransports(): readonly Transport[] {
  return transports;
}

/** Test/composition helper: drop all registered transports. */
export function clearTransports(): void {
  transports.length = 0;
}

/**
 * Resolve the first registered transport that claims the request, honoring each
 * transport's {@link Transport.enabledEnv} gate. Returns null when none match.
 */
export function matchTransport(url: URL, req: Request): Transport | null {
  for (const transport of transports) {
    if (transport.enabledEnv && Bun.env[transport.enabledEnv] !== 'true') continue;
    if (transport.matches(url, req)) return transport;
  }
  return null;
}
