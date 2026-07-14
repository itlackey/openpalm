/**
 * Deprecation scan for the removed `channel_lan` Docker network (#490).
 *
 * `channel_lan` was renamed to `portal_net` in 0.12.0 and retained one
 * release as an empty compatibility bridge; it is fully removed from the
 * skeleton in 0.13.0. A user overlay (`config/stack/custom.compose.yml`)
 * that still attaches a service to `channel_lan` without defining that
 * network itself would produce an invalid merged compose config the moment
 * the skeleton refresh lands. This module is a read-only, advisory scan run
 * BEFORE any lifecycle mutation so the failure is caught early with an
 * actionable message instead of a later, worse Docker error.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import { customComposeFilePath } from "./home.js";

const DEPRECATED_NETWORK = "channel_lan";
const REPLACEMENT_NETWORK = "portal_net";

export type ChannelLanScan = { referencedBy: string[]; definesNetwork: boolean };

/**
 * Pure: parse compose YAML content; report services whose `networks` include
 * channel_lan (list or map form) and whether top-level networks defines it.
 * Unparseable/non-object input -> empty scan (advisory scan, fail-open by
 * design: compose preflight still hard-fails genuinely broken YAML).
 */
export function scanComposeForChannelLan(content: string): ChannelLanScan {
  const empty: ChannelLanScan = { referencedBy: [], definesNetwork: false };
  try {
    const doc: unknown = yamlParse(content);
    if (typeof doc !== "object" || doc === null) return empty;

    const referencedBy: string[] = [];
    const services = (doc as Record<string, unknown>).services;
    if (typeof services === "object" && services !== null) {
      for (const [svcName, svcDef] of Object.entries(services as Record<string, unknown>)) {
        if (typeof svcDef !== "object" || svcDef === null) continue;
        const networks = (svcDef as Record<string, unknown>).networks;
        if (Array.isArray(networks)) {
          if (networks.some((n: unknown) => n === DEPRECATED_NETWORK)) referencedBy.push(svcName);
        } else if (typeof networks === "object" && networks !== null) {
          if (DEPRECATED_NETWORK in (networks as Record<string, unknown>)) referencedBy.push(svcName);
        }
      }
    }

    let definesNetwork = false;
    const topNetworks = (doc as Record<string, unknown>).networks;
    if (typeof topNetworks === "object" && topNetworks !== null) {
      definesNetwork = DEPRECATED_NETWORK in (topNetworks as Record<string, unknown>);
    }

    return { referencedBy, definesNetwork };
  } catch {
    return empty;
  }
}

/**
 * Read-only check of the user overlay (customComposeFilePath(homeDir)).
 * Missing file -> both null.
 * referencedBy.length > 0 && !definesNetwork -> blockError (merged config
 *   would fail `docker compose config`): names the services, the file path,
 *   instructs renaming to portal_net, and states nothing was changed.
 * definesNetwork -> warning (self-defined network still validates but is
 *   deprecated; suggest renaming to portal_net).
 */
export function checkCustomComposeChannelLan(homeDir: string): {
  blockError: string | null;
  warning: string | null;
} {
  const path = customComposeFilePath(homeDir);
  if (!existsSync(path)) return { blockError: null, warning: null };

  const content = readFileSync(path, "utf-8");
  const scan = scanComposeForChannelLan(content);

  if (scan.referencedBy.length > 0 && !scan.definesNetwork) {
    return {
      blockError:
        `Service(s) ${scan.referencedBy.join(", ")} in ${path} reference the removed ` +
        `"${DEPRECATED_NETWORK}" Docker network. Rename to "${REPLACEMENT_NETWORK}" in ${path}; ` +
        `nothing was changed.`,
      warning: null,
    };
  }

  if (scan.definesNetwork) {
    return {
      blockError: null,
      warning:
        `${path} defines a deprecated "${DEPRECATED_NETWORK}" network. It still validates, ` +
        `but you should rename it to "${REPLACEMENT_NETWORK}".`,
    };
  }

  return { blockError: null, warning: null };
}
