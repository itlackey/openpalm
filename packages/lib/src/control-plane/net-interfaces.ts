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
 * Interfaces that are container/VM plumbing, matched by NAME: the docker
 * bridge (docker0), compose-network bridges (br-*), and container veth pairs
 * (veth*). Their addresses are only reachable from the host itself, so
 * advertising them (mDNS A records, printed "type this on your phone" URLs)
 * hands out an address the phone cannot connect to. Deliberately NOT an
 * RFC1918-range filter — 172.17.* can be a genuine LAN.
 */
const VIRTUAL_BRIDGE_NAME_RE = /^(?:docker\d*|br-|veth)/;

/** 169.254.0.0/16 link-local addresses are not routable from another device. */
function isLinkLocalIpv4(address: string): boolean {
  return address.startsWith("169.254.");
}

/**
 * Every non-internal IPv4 address across all interfaces, in `node:os`'s own
 * enumeration order. Loopback and internal entries are excluded, as are
 * virtual-bridge interfaces and link-local addresses — none is reachable
 * from another device on the LAN.
 *
 * Defaults to the live host's interfaces; inject for tests.
 */
export function collectNonInternalIpv4(
  interfaces: LanInterfaceMap = networkInterfaces(),
): string[] {
  const addresses: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries || VIRTUAL_BRIDGE_NAME_RE.test(name)) continue;
    for (const entry of entries) {
      if (isIpv4Family(entry.family) && !entry.internal && !isLinkLocalIpv4(entry.address)) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}
