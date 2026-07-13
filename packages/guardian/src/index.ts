/**
 * `@openpalm/guardian` public library surface.
 *
 * Importing this module is side-effect free — it does NOT bind any listener.
 * `server.ts` only boots when run as the entrypoint (`import.meta.main`), so a
 * downstream composition root can import the seams, wire them up, and then call
 * {@link startGuardian} / {@link createGuardian} itself.
 *
 * ```ts
 * import { createGuardian } from '@openpalm/guardian';
 * createGuardian()
 *   .setAuthStrategy(myOidcStrategy)   // SSO/OIDC instead of Basic tokens
 *   .registerTransport(myA2aTransport) // additive /a2a route
 *   .start();
 * ```
 */
import { startGuardian, type GuardianServers, type StartGuardianOptions } from './server.ts';
import { setAuthStrategy, type AuthStrategy } from './auth.ts';
import type { Transport } from './transport.ts';

// --- composition root ---
export { startGuardian };
export type { GuardianServers, StartGuardianOptions };

// --- transport seam (additive direct-listener protocols, e.g. A2A) ---
export {
  registerTransport,
  registeredTransports,
  clearTransports,
  matchTransport,
} from './transport.ts';
export type { Transport };

// --- authentication seam (e.g. SSO/OIDC) ---
export {
  authenticate,
  setAuthStrategy,
  getAuthStrategy,
  resetAuthStrategy,
  basicTokenAuthStrategy,
  invalidatePrincipalCache,
} from './auth.ts';
export type { AuthStrategy, AuthenticatedPrincipal } from './auth.ts';

// --- principal store (token-backed identities the guardian trusts) ---
export {
  initializePrincipalStore,
  listPrincipals,
  getPrincipalRecord,
  upsertPrincipal,
  rotatePrincipal,
  setPrincipalEnabled,
  deletePrincipal,
  seedPortalPrincipalsFromEnv,
  hashToken,
} from './state-db.ts';
export type { PrincipalKind, PrincipalRecord } from './state-db.ts';

// --- ownership (a principal may only touch sessions it created) ---
export {
  principalKey,
  recordSessionOwner,
  ownsSession,
  forgetSession,
  ownedSessionIds,
  recordPermissionOwner,
  ownsPermission,
} from './ownership.ts';
export type { Principal } from './ownership.ts';

/**
 * Fluent composition root. Chain seam wiring, then {@link GuardianBuilder.start}.
 * Equivalent to the standalone `setAuthStrategy` / `registerTransport` +
 * {@link startGuardian} calls.
 */
export interface GuardianBuilder {
  setAuthStrategy(strategy: AuthStrategy): GuardianBuilder;
  registerTransport(transport: Transport): GuardianBuilder;
  start(options?: StartGuardianOptions): GuardianServers;
}

export function createGuardian(): GuardianBuilder {
  const transports: Transport[] = [];
  const builder: GuardianBuilder = {
    setAuthStrategy(strategy) {
      setAuthStrategy(strategy);
      return builder;
    },
    registerTransport(transport) {
      transports.push(transport);
      return builder;
    },
    start(options: StartGuardianOptions = {}) {
      return startGuardian({ ...options, transports: [...transports, ...(options.transports ?? [])] });
    },
  };
  return builder;
}
