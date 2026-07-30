/**
 * LAN URLs — the concrete addresses a person can type into a phone's browser
 * to reach the OpenPalm UI.
 *
 * "What URL do I open on my phone?" is the single most predictable support
 * question `networkAccess` raises (Phase 2 of the LAN-access review), and
 * nothing in the tree answered it: `mdns-responder.ts` derives
 * `<project>.local` purely to gate its OWN advertisement, and no module
 * assembled the sibling IPv4 URLs a person falls back to when `.local`
 * resolution does not work on their network — which it frequently does not on
 * a stock Android phone.
 *
 * Pure and interface-list-injectable, so it is unit-testable without touching
 * real network interfaces — `networkInterfaces()` is consulted only as the
 * default at the call site, mirroring `resolveMdnsAdvertisements`'s own
 * `hostIpv4` parameter in `mdns-responder.ts`.
 */
import { networkInterfaces } from "node:os";
import { deriveMdnsNames } from "./mdns-responder.js";

/**
 * The subset of `node:os`'s `NetworkInterfaceInfo` this module reads. A
 * reduced local shape (rather than importing the full node:os type) keeps the
 * builder trivially constructible from a plain object in tests.
 */
export type LanInterfaceEntry = {
  address: string;
  /**
   * Current `@types/node` types this as the string literal union `"IPv4" |
   * "IPv6"`; older Node runtimes can report the numeric family (4) instead
   * (see `mdns-responder.ts`'s identical comment on its own `defaultHostIpv4`).
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
 */
export function collectNonInternalIpv4(interfaces: LanInterfaceMap): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (isIpv4Family(entry.family) && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

export type BuildLanUrlsInput = {
  /** The UI's published host port (`OP_UI_PORT`) — the caller resolves the default. */
  port: number;
  /** `OP_PROJECT_NAME`, or `""` — `deriveMdnsNames` falls back to `"openpalm"`. */
  projectName: string;
  /** Defaults to the live host's interfaces; inject for tests. */
  interfaces?: LanInterfaceMap;
};

/**
 * The concrete URLs to type: the derived `<project>.local` mDNS name first
 * (works only while a host `openpalm` process is running and the client's
 * network resolves mDNS), then every non-loopback IPv4 address — the durable
 * fallback that keeps working when `.local` does not.
 *
 * Deliberately independent of whether anything is actually published or
 * currently advertised over mDNS: this list is the "what you would type"
 * half of the access-status answer, paired at the call site with a
 * `reachable` self-probe for the "does it currently work" half — showing
 * both is the point, since they can disagree (that disagreement is exactly
 * the drift the toggles model exists to make visible instead of assumed away).
 */
export function buildLanUrls(input: BuildLanUrlsInput): string[] {
  const { assistantName } = deriveMdnsNames({ OP_PROJECT_NAME: input.projectName });
  const interfaces = input.interfaces ?? networkInterfaces();
  const urls = [`http://${assistantName}:${input.port}`];
  for (const address of collectNonInternalIpv4(interfaces)) {
    urls.push(`http://${address}:${input.port}`);
  }
  return urls;
}
