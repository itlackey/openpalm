import { stringifyPretty } from "../jsonc.ts";
import { channelEnvSecretVariable } from "./stack-spec.ts";
import type { StackChannelName, StackSpec } from "./stack-spec.ts";

const ChannelPorts: Record<StackChannelName, string> = {
  chat: "8181",
  discord: "8184",
  voice: "8183",
  telegram: "8182",
};

const ChannelRewritePaths: Record<StackChannelName, string> = {
  chat: "/chat",
  discord: "/discord/webhook",
  voice: "/voice/transcription",
  telegram: "/telegram/webhook",
};

const Channels: StackChannelName[] = ["chat", "voice", "discord", "telegram"];

export type GeneratedStackArtifacts = {
  caddyfile: string;
  composeFile: string;
  opencodePluginConfigJsonc: string;
  opencodePluginIds: string[];
  gatewayChannelSecretsEnv: string;
  channelSecretsEnv: Record<StackChannelName, string>;
  channelConfigEnv: Record<StackChannelName, string>;
};

function renderChannelRoute(channel: StackChannelName, spec: StackSpec): string {
  const cfg = spec.channels[channel];
  if (!cfg.enabled) return "";
  const lines = [`\thandle /channels/${channel}* {`];
  if (cfg.exposure === "lan") lines.push("\t\tabort @not_lan");
  lines.push(`\t\trewrite * ${ChannelRewritePaths[channel]}`);
  lines.push(`\t\treverse_proxy channel-${channel}:${ChannelPorts[channel]}`);
  lines.push("\t}");
  return `${lines.join("\n")}\n`;
}

function renderLanMatcher(scope: StackSpec["accessScope"]): string {
  if (scope === "host") return "127.0.0.0/8 ::1";
  return "127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 ::1 fd00::/8";
}

function envWithHeader(header: string, entries: Record<string, string>): string {
  const lines = [header];
  for (const [key, value] of Object.entries(entries)) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

function renderFullComposeFile(spec: StackSpec): string {
  const channelServices = Channels
    .filter((channel) => spec.channels[channel].enabled)
    .map((channel) => [
      `  channel-${channel}:`,
      `    image: \${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-${channel}:\${OPENPALM_IMAGE_TAG:-latest}`,
      "    restart: unless-stopped",
      "    env_file:",
      `      - \${OPENPALM_CONFIG_HOME}/channels/${channel}.env`,
      `      - \${OPENPALM_CONFIG_HOME}/secrets/channels/${channel}.env`,
      "    environment:",
      `      - PORT=${ChannelPorts[channel]}`,
      "      - GATEWAY_URL=http://gateway:8080",
      "    networks: [assistant_net]",
      "    depends_on: [gateway]",
      "",
    ].join("\n"))
    .join("\n");

  return [
    "services:",
    "  caddy:",
    "    image: caddy:2-alpine",
    "    restart: unless-stopped",
    "    ports:",
    "      - \"${OPENPALM_INGRESS_BIND_ADDRESS:-0.0.0.0}:80:80\"",
    "      - \"${OPENPALM_INGRESS_BIND_ADDRESS:-0.0.0.0}:443:443\"",
    "    volumes:",
    "      - ${OPENPALM_CONFIG_HOME}/caddy/Caddyfile:/etc/caddy/Caddyfile:ro",
    "      - ${OPENPALM_DATA_HOME}/caddy:/data",
    "      - ${OPENPALM_STATE_HOME}/caddy:/config",
    "    networks: [assistant_net]",
    "    depends_on: [gateway, admin, openmemory-ui]",
    "",
    "  postgres:",
    "    image: postgres:16-alpine",
    "    restart: unless-stopped",
    "    environment:",
    "      POSTGRES_DB: ${POSTGRES_DB:-openpalm}",
    "      POSTGRES_USER: ${POSTGRES_USER:-openpalm}",
    "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-change-me-pg-password}",
    "    volumes:",
    "      - ${OPENPALM_DATA_HOME}/postgres:/var/lib/postgresql/data",
    "    networks: [assistant_net]",
    "",
    "  qdrant:",
    "    image: qdrant/qdrant:latest",
    "    restart: unless-stopped",
    "    volumes:",
    "      - ${OPENPALM_DATA_HOME}/qdrant:/qdrant/storage",
    "    networks: [assistant_net]",
    "",
    "  openmemory:",
    "    image: mem0/openmemory-mcp:latest",
    "    restart: unless-stopped",
    "    env_file:",
    "      - ${OPENPALM_CONFIG_HOME}/user.env",
    "      - ${OPENPALM_CONFIG_HOME}/secrets.env",
    "    ports:",
    "      - \"${OPENPALM_OPENMEMORY_BIND_ADDRESS:-0.0.0.0}:8765:8765\"",
    "    volumes:",
    "      - ${OPENPALM_DATA_HOME}/openmemory:/data",
    "      - ${OPENPALM_DATA_HOME}/shared:/shared",
    "    networks: [assistant_net]",
    "    depends_on: [qdrant]",
    "",
    "  openmemory-ui:",
    "    image: mem0/openmemory-ui:latest",
    "    restart: unless-stopped",
    "    environment:",
    "      - NEXT_PUBLIC_API_URL=${OPENMEMORY_DASHBOARD_API_URL:-http://localhost:8765}",
    "      - NEXT_PUBLIC_USER_ID=${OPENMEMORY_USER_ID:-default-user}",
    "    ports:",
    "      - \"${OPENPALM_OPENMEMORY_UI_BIND_ADDRESS:-0.0.0.0}:3000:3000\"",
    "    networks: [assistant_net]",
    "    depends_on: [openmemory]",
    "",
    "  opencode-core:",
    "    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/opencode-core:${OPENPALM_IMAGE_TAG:-latest}",
    "    restart: unless-stopped",
    "    env_file:",
    "      - ${OPENPALM_CONFIG_HOME}/user.env",
    "      - ${OPENPALM_CONFIG_HOME}/secrets.env",
    "    environment:",
    "      - OPENCODE_CONFIG_DIR=/config",
    "      - OPENCODE_CONFIG=/config/opencode.jsonc",
    "      - OPENCODE_PORT=4096",
    "      - CRON_DIR=/cron",
    "    ports:",
    "      - \"${OPENCODE_CORE_BIND_ADDRESS:-127.0.0.1}:4096:4096\"",
    "    volumes:",
    "      - ${OPENPALM_CONFIG_HOME}/opencode-core:/config",
    "      - ${OPENPALM_CONFIG_HOME}/cron:/cron",
    "      - ${OPENPALM_STATE_HOME}/workspace:/work",
    "    working_dir: /work",
    "    networks: [assistant_net]",
    "    depends_on: [openmemory]",
    "",
    "  gateway:",
    "    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/gateway:${OPENPALM_IMAGE_TAG:-latest}",
    "    restart: unless-stopped",
    "    env_file:",
    "      - ${OPENPALM_CONFIG_HOME}/secrets/gateway/channels.env",
    "    environment:",
    "      - PORT=8080",
    "      - OPENCODE_CORE_BASE_URL=http://opencode-core:4096",
    "      - OPENCODE_TIMEOUT_MS=${OPENCODE_TIMEOUT_MS:-15000}",
    "    networks: [assistant_net]",
    "    depends_on: [opencode-core]",
    "",
    "  admin:",
    "    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:${OPENPALM_IMAGE_TAG:-latest}",
    "    restart: unless-stopped",
    "    environment:",
    "      - PORT=8100",
    "      - ADMIN_TOKEN=${ADMIN_TOKEN:-change-me-admin-token}",
    "      - OPENCODE_CONFIG_PATH=/app/config/opencode-core/opencode.jsonc",
    "      - CADDYFILE_PATH=/app/config/caddy/Caddyfile",
    "      - CHANNEL_ENV_DIR=/app/channel-env",
    "      - STACK_SPEC_PATH=/app/config-root/stack-spec.json",
    "      - COMPOSE_FILE_PATH=/workspace/docker-compose.yml",
    "    volumes:",
    "      - ${OPENPALM_CONFIG_HOME}:/app/config-root",
    "      - ${OPENPALM_CONFIG_HOME}/channels:/app/channel-env",
    "      - ${OPENPALM_STATE_HOME}:/workspace",
    "      - ${OPENPALM_CONTAINER_SOCKET_PATH:-/var/run/docker.sock}:${OPENPALM_CONTAINER_SOCKET_IN_CONTAINER:-/var/run/docker.sock}",
    "    networks: [assistant_net]",
    "    depends_on: [gateway, opencode-core]",
    "",
    channelServices.trimEnd(),
    "",
    "networks:",
    "  assistant_net:",
    "",
  ].join("\n");
}

function renderOpencodePluginConfig(spec: StackSpec) {
  const plugins = spec.extensions
    .filter((extension) => extension.type === "plugin" && extension.enabled && typeof extension.pluginId === "string")
    .map((extension) => extension.pluginId as string);
  return {
    opencodePluginIds: plugins,
    opencodePluginConfigJsonc: stringifyPretty({ plugin: plugins }),
  };
}

export function generateStackArtifacts(spec: StackSpec, secrets: Record<string, string>): GeneratedStackArtifacts {
  const lanMatcher = renderLanMatcher(spec.accessScope);
  const channelBlocks = Channels
    .map((channel) => renderChannelRoute(channel, spec))
    .filter((value) => value.length > 0)
    .join("\n");

  const caddyfile = [
    "{",
    "\tadmin off",
    "}",
    "",
    ":80 {",
    `\t@lan remote_ip ${lanMatcher}`,
    `\t@not_lan not remote_ip ${lanMatcher}`,
    "",
    "\t# Channel ingress (generated from stack spec)",
    channelBlocks.trimEnd(),
    "",
    "\t# LAN-only admin umbrella",
    "\thandle /admin* {",
    "\t\tabort @not_lan",
    "\t\troute {",
    "\t\t\thandle /admin/api* {",
    "\t\t\t\turi replace /admin/api /admin",
    "\t\t\t\treverse_proxy admin:8100",
    "\t\t\t}",
    "",
    "\t\t\thandle_path /admin/opencode* {",
    "\t\t\t\treverse_proxy opencode-core:4096",
    "\t\t\t}",
    "",
    "\t\t\thandle_path /admin/openmemory* {",
    "\t\t\t\treverse_proxy openmemory-ui:3000",
    "\t\t\t}",
    "",
    "\t\t\turi strip_prefix /admin",
    "\t\t\treverse_proxy admin:8100",
    "\t\t}",
    "\t}",
    "",
    "\t# Default: proxy to opencode-core web UI.",
    "\thandle {",
    "\t\tabort @not_lan",
    "\t\treverse_proxy opencode-core:4096",
    "\t}",
    "}",
    "",
  ].join("\n");

  const gatewayEntries: Record<string, string> = {};
  for (const channel of Channels) {
    const ref = spec.secrets.gatewayChannelSecrets[channel];
    const envVar = channelEnvSecretVariable(channel);
    gatewayEntries[envVar] = secrets[ref] ?? "";
  }
  const gatewayChannelSecretsEnv = envWithHeader("# Generated gateway channel secrets", gatewayEntries);

  const channelSecretsEnv: Record<StackChannelName, string> = { chat: "", discord: "", voice: "", telegram: "" };
  const channelConfigEnv: Record<StackChannelName, string> = { chat: "", discord: "", voice: "", telegram: "" };

  for (const channel of Channels) {
    const ref = spec.secrets.channelServiceSecrets[channel];
    const envVar = channelEnvSecretVariable(channel);
    channelSecretsEnv[channel] = envWithHeader(`# Generated ${channel} channel secrets`, { [envVar]: secrets[ref] ?? "" });
    channelConfigEnv[channel] = envWithHeader(`# Generated ${channel} channel config`, spec.channels[channel].config);
  }

  const pluginConfig = renderOpencodePluginConfig(spec);

  return {
    caddyfile,
    composeFile: renderFullComposeFile(spec),
    ...pluginConfig,
    gatewayChannelSecretsEnv,
    channelSecretsEnv,
    channelConfigEnv,
  };
}
