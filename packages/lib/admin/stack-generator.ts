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
  caddyRoutes: Record<string, string>;
  composeFile: string;
  gatewayEnv: string;
  openmemoryEnv: string;
  postgresEnv: string;
  qdrantEnv: string;
  opencodeEnv: string;
  channelsEnv: string;
};

function renderChannelRoute(channel: StackChannelName, spec: StackSpec): string {
  const cfg = spec.channels[channel];
  if (!cfg.enabled) return "";
  const lines = ["handle /channels/" + channel + "* {"];
  if (cfg.exposure === "lan") lines.push("\tabort @not_lan");
  lines.push(`\trewrite * ${ChannelRewritePaths[channel]}`);
  lines.push(`\treverse_proxy channel-${channel}:${ChannelPorts[channel]}`);
  lines.push("}");
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

function pickEnvByPrefixes(secrets: Record<string, string>, prefixes: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) result[key] = value;
  }
  return result;
}

function pickEnvByKeys(secrets: Record<string, string>, keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) result[key] = secrets[key] ?? "";
  return result;
}

function renderFullComposeFile(spec: StackSpec): string {
  const channelServices = Channels
    .filter((channel) => spec.channels[channel].enabled)
    .map((channel) => [
      `  channel-${channel}:`,
      `    image: \${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-${channel}:\${OPENPALM_IMAGE_TAG:-latest}`,
      "    restart: unless-stopped",
      "    env_file:",
      "      - ${OPENPALM_STATE_HOME}/rendered/env/channels.env",
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
    "      - ${OPENPALM_STATE_HOME}/rendered/caddy/Caddyfile:/etc/caddy/Caddyfile:ro",
    "      - ${OPENPALM_STATE_HOME}/rendered/caddy/snippets:/etc/caddy/snippets:ro",
    "      - ${OPENPALM_STATE_HOME}/caddy/data:/data/caddy",
    "      - ${OPENPALM_STATE_HOME}/caddy/config:/config/caddy",
    "    networks: [assistant_net]",
    "    depends_on: [gateway, admin, openmemory-ui]",
    "",
    "  postgres:",
    "    image: postgres:16-alpine",
    "    restart: unless-stopped",
    "    env_file:",
    "      - ${OPENPALM_STATE_HOME}/rendered/env/postgres.env",
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
    "    env_file:",
    "      - ${OPENPALM_STATE_HOME}/rendered/env/qdrant.env",
    "    volumes:",
    "      - ${OPENPALM_DATA_HOME}/qdrant:/qdrant/storage",
    "    networks: [assistant_net]",
    "",
    "  openmemory:",
    "    image: mem0/openmemory-mcp:latest",
    "    restart: unless-stopped",
    "    env_file:",
    "      - ${OPENPALM_STATE_HOME}/rendered/env/openmemory.env",
    "    ports:",
    "      - \"${OPENPALM_OPENMEMORY_BIND_ADDRESS:-0.0.0.0}:8765:8765\"",
    "    volumes:",
    "      - ${OPENPALM_DATA_HOME}/openmemory:/data",
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
    "      - ${OPENPALM_STATE_HOME}/rendered/env/opencode.env",
    "    environment:",
    "      - OPENCODE_CONFIG_DIR=/opt/opencode",
    "      - OPENCODE_PORT=4096",
    "      - OPENCODE_ENABLE_SSH=${OPENCODE_ENABLE_SSH:-0}",
    "      - HOME=/home/opencode",
    "    ports:",
    "      - \"${OPENCODE_CORE_BIND_ADDRESS:-127.0.0.1}:4096:4096\"",
    "      - \"${OPENCODE_CORE_SSH_BIND_ADDRESS:-127.0.0.1}:${OPENCODE_CORE_SSH_PORT:-2222}:22\"",
    "    volumes:",
    "      - ${OPENPALM_DATA_HOME}/opencode:/home/opencode",
    "      - ${HOME}/openpalm:/work",
    "    working_dir: /work",
    "    user: \"${OPENPALM_UID:-1000}:${OPENPALM_GID:-1000}\"",
    "    networks: [assistant_net]",
    "    depends_on: [openmemory]",
    "",
    "  gateway:",
    "    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/gateway:${OPENPALM_IMAGE_TAG:-latest}",
    "    restart: unless-stopped",
    "    env_file:",
    "      - ${OPENPALM_STATE_HOME}/rendered/env/gateway.env",
    "    environment:",
    "      - PORT=8080",
    "      - OPENCODE_CORE_BASE_URL=http://opencode-core:4096",
    "      - OPENCODE_TIMEOUT_MS=${OPENCODE_TIMEOUT_MS:-15000}",
    "    volumes:",
    "      - ${OPENPALM_STATE_HOME}/gateway:/app/data",
    "    networks: [assistant_net]",
    "    depends_on: [opencode-core]",
    "",
    "  admin:",
    "    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:${OPENPALM_IMAGE_TAG:-latest}",
    "    restart: unless-stopped",
    "    environment:",
    "      - PORT=8100",
    "      - ADMIN_TOKEN=${ADMIN_TOKEN:-change-me-admin-token}",
    "    volumes:",
    "      - ${OPENPALM_DATA_HOME}:/data",
    "      - ${OPENPALM_CONFIG_HOME}:/config",
    "      - ${OPENPALM_STATE_HOME}:/state",
    "      - ${HOME}/openpalm:/work",
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

export function generateStackArtifacts(spec: StackSpec, secrets: Record<string, string>): GeneratedStackArtifacts {
  const lanMatcher = renderLanMatcher(spec.accessScope);
  const channelRoutes: Record<string, string> = {};
  for (const channel of Channels) {
    const route = renderChannelRoute(channel, spec);
    if (route.length > 0) channelRoutes[`channels/${channel}.caddy`] = route;
  }

  const caddyfile = [
    "{",
    "\tadmin off",
    "}",
    "",
    ":80 {",
    `\t@lan remote_ip ${lanMatcher}`,
    `\t@not_lan not remote_ip ${lanMatcher}`,
    "",
    "\timport /etc/caddy/snippets/admin.caddy",
    "\timport /etc/caddy/snippets/channels/*.caddy",
    "\timport /etc/caddy/snippets/extra-user-overrides.caddy",
    "}",
    "",
  ].join("\n");

  const caddyAdminRoute = [
    "# Admin and defaults (generated from stack spec)",
    "handle /admin* {",
    "\tabort @not_lan",
    "\troute {",
    "\t\thandle /admin/api* {",
    "\t\t\turi replace /admin/api /admin",
    "\t\t\treverse_proxy admin:8100",
    "\t\t}",
    "",
    "\t\thandle_path /admin/opencode* {",
    "\t\t\treverse_proxy opencode-core:4096",
    "\t\t}",
    "",
    "\t\thandle_path /admin/openmemory* {",
    "\t\t\treverse_proxy openmemory-ui:3000",
    "\t\t}",
    "",
    "\t\turi strip_prefix /admin",
    "\t\treverse_proxy admin:8100",
    "\t}",
    "}",
    "",
    "handle {",
    "\tabort @not_lan",
    "\treverse_proxy opencode-core:4096",
    "}",
    "",
  ].join("\n");

  const caddyRoutes: Record<string, string> = {
    "admin.caddy": caddyAdminRoute,
    "extra-user-overrides.caddy": "# user-managed overrides\n",
    ...channelRoutes,
  };

  const gatewayEnv = envWithHeader("# Generated gateway env", {
    ...pickEnvByPrefixes(secrets, ["OPENPALM_GATEWAY_", "GATEWAY_", "OPENPALM_CONN_", "OPENPALM_SMALL_MODEL_API_KEY", "ANTHROPIC_API_KEY"]),
    ...Object.fromEntries(Channels.map((channel) => {
      const ref = spec.secrets.gatewayChannelSecrets[channel];
      const envVar = channelEnvSecretVariable(channel);
      return [envVar, secrets[ref] ?? ""];
    })),
  });

  const channelsEnv = envWithHeader("# Generated channels env", Object.assign(
    {},
    ...Channels.map((channel) => {
      const ref = spec.secrets.channelServiceSecrets[channel];
      const envVar = channelEnvSecretVariable(channel);
      return { ...spec.channels[channel].config, [envVar]: secrets[ref] ?? "" };
    }),
  ));

  return {
    caddyfile,
    caddyRoutes,
    composeFile: renderFullComposeFile(spec),
    gatewayEnv,
    openmemoryEnv: envWithHeader("# Generated openmemory env", pickEnvByKeys(secrets, ["OPENAI_BASE_URL", "OPENAI_API_KEY"])),
    postgresEnv: envWithHeader("# Generated postgres env", pickEnvByKeys(secrets, ["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"])),
    qdrantEnv: envWithHeader("# Generated qdrant env", {}),
    opencodeEnv: envWithHeader("# Generated opencode env", pickEnvByPrefixes(secrets, ["OPENPALM_CONN_", "OPENPALM_SMALL_MODEL_API_KEY", "ANTHROPIC_API_KEY"])),
    channelsEnv,
  };
}
