/**
 * Host network-interface enumeration — the one place that decides which of a
 * machine's addresses count as "reachable from another device on the LAN".
 *
 * Both LAN consumers need the same answer and used to compute it separately:
 * `lan-urls.ts` builds the URLs a person types into a phone, and
 * `mdns-responder.ts` picks the A records it advertises. Each carried its own
 * copy of the loop, including the same numeric-vs-string `family` shim, and
 * each documented the duplication in prose rather than removing it — so a fix
 * to the family quirk, or a new filter (link-local, a docker bridge), would
 * have had to land twice for the advertised address and the printed URL to keep
 * agreeing. This module is a leaf: `lan-urls.ts` imports `mdns-responder.ts`,
 * so the shared helper cannot live in either without a cycle.
 */
import { networkInterfaces } from "node:os";

/**
 * The subset of `node:os`'s `NetworkInterfaceInfo` these callers read. A
 * reduced local shape (rather than importing the full node:os type) keeps them
 * trivially constructible from a plain object in tests.
 */
export type LanInterfaceEntry = {
  address: string;
  /**
   * Current `@types/node` types this as the string literal union `"IPv4" |
   * "IPv6"`; older Node runtimes can report the numeric family (4) instead.
   */
  family: string | number;
  internal: boolean;
};

/** The shape `node:os`'s `networkInterfaces()` returns. */
export type LanInterfaceMap = Record<string, LanInterfaceEntry[] | undefined>;

function isIpv4Family(family: string | number): boolean {
  return family === "IPv4" || family === 4;
}

/**
 * Every non-internal IPv4 address across all interfaces, in `node:os`'s own
 * enumeration order. Loopback and internal entries are excluded — neither is
 * reachable from another device on the LAN.
 *
 * Defaults to the live host's interfaces; inject for tests.
 */
export function collectNonInternalIpv4(
  interfaces: LanInterfaceMap = networkInterfaces(),
): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (isIpv4Family(entry.family) && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}
