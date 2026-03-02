/**
 * Channel registry catalog — discovered at build time from channels.json.
 *
 * Adding a new registry channel = adding an entry to registry/channels.json.
 */

// @ts-ignore — JSON asset import bundled by Vite at build time
import channelCatalog from "$registry/channels.json";

// ── Types ────────────────────────────────────────────────────────────────

export type ChannelRegistryEntry = {
  /** npm package name (e.g., "@openpalm/channel-discord"). Mutually exclusive with image. */
  package?: string;
  /** Custom Docker image. When set, the system uses this image instead of channel-runner. */
  image?: string;
  /** Package version constraint. */
  version?: string;
  /** Port the channel listens on. */
  port: number;
  /** Docker Compose networks to attach. */
  networks: string[];
  /** Env vars the channel needs (auto-populated in per-channel .env file). */
  envVars: string[];
  /** Optional Caddy route snippet for HTTP routing. */
  caddy?: string;
  /** Human-readable description. */
  description?: string;
};

// ── Exports ──────────────────────────────────────────────────────────────

/** Full registry catalog keyed by channel name */
export const CHANNEL_REGISTRY: Record<string, ChannelRegistryEntry> = channelCatalog;

/** Names of registry channels */
export const REGISTRY_CHANNEL_NAMES: string[] = Object.keys(channelCatalog);

/** Generate a compose YAML overlay for a channel from registry metadata */
export function generateChannelCompose(name: string, entry: ChannelRegistryEntry, configDir: string): string {
  const serviceName = `channel-${name}`;
  const image = entry.image
    ? entry.image
    : `\${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-runner:\${OPENPALM_IMAGE_TAG:-latest}`;

  const envLines: string[] = [
    `      PORT: "${entry.port}"`,
    `      GUARDIAN_URL: http://guardian:8080`,
  ];
  if (entry.package) {
    envLines.push(`      CHANNEL_PACKAGE: ${entry.package}`);
  }
  for (const v of entry.envVars) {
    envLines.push(`      ${v}: \${${v}}`);
  }

  const networkList = entry.networks.map(n => `      - ${n}`).join("\n") || "      - channel_lan";

  return `services:
  ${serviceName}:
    image: ${image}
    restart: unless-stopped
    env_file:
      - path: ${configDir}/channels/${name}.env
        required: false
    environment:
${envLines.join("\n")}
    networks:
${networkList}
    depends_on:
      guardian:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/${entry.port}' || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
`;
}
