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
 * default at the call site. Which addresses count as LAN-reachable is
 * `net-interfaces.ts`'s answer, shared with the mDNS responder so the URL
 * printed here and the A record advertised there can never disagree.
 */
import { collectNonInternalIpv4, type LanInterfaceMap } from "./net-interfaces.js";
import { deriveMdnsNames } from "./mdns-responder.js";

export { collectNonInternalIpv4 };
export type { LanInterfaceEntry, LanInterfaceMap } from "./net-interfaces.js";

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
  const urls = [`http://${assistantName}:${input.port}`];
  for (const address of collectNonInternalIpv4(input.interfaces)) {
    urls.push(`http://${address}:${input.port}`);
  }
  return urls;
}
