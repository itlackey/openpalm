import { parseSecretReference, isBuiltInChannel, BuiltInChannelPorts, BuiltInChannelNames } from "./stack-spec.ts";
import type { BuiltInChannelName, StackChannelConfig, StackSpec } from "./stack-spec.ts";

const BuiltInChannelRewritePaths: Record<BuiltInChannelName, string> = {
  chat: "/chat",
  discord: "/discord/webhook",
  voice: "/voice/transcription",
  telegram: "/telegram/webhook",
};

const BuiltInChannelSharedSecretEnv: Record<BuiltInChannelName, string> = {
  chat: "CHANNEL_CHAT_SECRET",
  discord: "CHANNEL_DISCORD_SECRET",
  voice: "CHANNEL_VOICE_SECRET",
  telegram: "CHANNEL_TELEGRAM_SECRET",
};

function resolveChannelPort(name: string, config: StackChannelConfig): number {
  if (config.containerPort) return config.containerPort;
  if (isBuiltInChannel(name)) return BuiltInChannelPorts[name];
  throw new Error(`missing_container_port_for_channel_${name}`);
}

function resolveChannelHostPort(name: string, config: StackChannelConfig): number {
  if (config.hostPort) return config.hostPort;
  return resolveChannelPort(name, config);
}

function resolveChannelImage(name: string, config: StackChannelConfig): string {
  if (config.image) return config.image;
  if (isBuiltInChannel(name)) {
    return `\${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-${name}:\${OPENPALM_IMAGE_TAG:-latest}`;
  }
  throw new Error(`missing_image_for_channel_${name}`);
}

function publishedChannelPort(name: string, config: StackChannelConfig): string {
  const containerPort = resolveChannelPort(name, config);
  const hostPort = resolveChannelHostPort(name, config);

  if (config.exposure === "host") {
    return `127.0.0.1:${hostPort}:${containerPort}`;
  }
  return `${hostPort}:${containerPort}`;
}

function composeServiceName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

export type GeneratedStackArtifacts = {
  caddyfile: string;
  caddyJson: string;
  caddyRoutes: Record<string, string>;
  composeFile: string;
  gatewayEnv: string;
  openmemoryEnv: string;
  postgresEnv: string;
  qdrantEnv: string;
  opencodeEnv: string;
  channelEnvs: Record<string, string>;
};

function renderChannelRoute(name: string, spec: StackSpec): string {
  const cfg = spec.channels[name];
  if (!cfg.enabled) return "";
  if (cfg.domains && cfg.domains.length > 0) return "";

  const containerPort = resolveChannelPort(name, cfg);
  const svcName = `channel-${composeServiceName(name)}`;

  if (isBuiltInChannel(name)) {
    const rewritePath = BuiltInChannelRewritePaths[name];
    const lines = [`handle /channels/${name}* {`];
    if (cfg.exposure === "lan") lines.push("\tabort @not_lan");
    if (cfg.exposure === "host") lines.push("\tabort @not_host");
    lines.push(`\trewrite * ${rewritePath}`);
    lines.push(`\treverse_proxy ${svcName}:${containerPort}`);
    lines.push("}");
    return `${lines.join("\n")}\n`;
  }

  // Custom channels: strip the /channels/{name} prefix and forward the rest of the path
  const lines = [`handle_path /channels/${name}* {`];
  if (cfg.exposure === "lan") lines.push("\tabort @not_lan");
  if (cfg.exposure === "host") lines.push("\tabort @not_host");
  lines.push(`\treverse_proxy ${svcName}:${containerPort}`);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function renderDomainBlocks(spec: StackSpec): string {
  const blocks: string[] = [];
  const lanMatcher = renderLanMatcher(spec.accessScope);

  for (const [name, cfg] of Object.entries(spec.channels)) {
    if (!cfg.enabled) continue;
    if (!cfg.domains || cfg.domains.length === 0) continue;

    const containerPort = resolveChannelPort(name, cfg);
    const svcName = `channel-${composeServiceName(name)}`;
    const paths = cfg.pathPrefixes?.length ? cfg.pathPrefixes : ["/"];
    const siteLabel = cfg.domains.join(", ");

    const lines: string[] = [`${siteLabel} {`];

    const useInternalTls = cfg.exposure !== "public";
    if (useInternalTls) {
      lines.push("\ttls internal");
    }

    if (cfg.exposure === "lan") {
      lines.push(`\t@not_lan not remote_ip ${lanMatcher}`);
      lines.push("\tabort @not_lan");
    } else if (cfg.exposure === "host") {
      lines.push("\t@not_host not remote_ip 127.0.0.0/8 ::1");
      lines.push("\tabort @not_host");
    }

    for (const p of paths) {
      const prefix = p.startsWith("/") ? p : `/${p}`;
      if (prefix === "/" || prefix === "/*") {
        lines.push(`\treverse_proxy ${svcName}:${containerPort}`);
      } else {
        lines.push(`\thandle_path ${prefix}* {`);
        lines.push(`\t\treverse_proxy ${svcName}:${containerPort}`);
        lines.push("\t}");
      }
    }

    lines.push("}");
    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
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

function resolveScalar(value: string, secrets: Record<string, string>, fieldName: string): string {
  const ref = parseSecretReference(value);
  if (!ref) return value;
  if (secrets[ref] === undefined || secrets[ref].length === 0) throw new Error(`unresolved_secret_reference_${fieldName}_${ref}`);
  return secrets[ref];
}

function resolveChannelConfig(name: string, cfg: StackChannelConfig, secrets: Record<string, string>): Record<string, string> {
  const channelEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(cfg.config)) {
    channelEnv[key] = resolveScalar(value, secrets, `${name}_${key}`);
  }
  return channelEnv;
}

function renderChannelComposeService(name: string, config: StackChannelConfig): string {
  const svcName = `channel-${composeServiceName(name)}`;
  const image = resolveChannelImage(name, config);
  const containerPort = resolveChannelPort(name, config);
  const portBinding = publishedChannelPort(name, config);

  return [
    `  ${svcName}:`,
    `    image: ${image}`,
    "    restart: unless-stopped",
    "    env_file:",
    `      - \${OPENPALM_STATE_HOME}/${svcName}/.env`,
    "    environment:",
    `      - PORT=${containerPort}`,
    "      - GATEWAY_URL=http://gateway:8080",
    "    ports:",
    `      - "${portBinding}"`,
    "    networks: [assistant_net]",
    "    depends_on: [gateway]",
    "",
  ].join("\n");
}

function renderFullComposeFile(spec: StackSpec): string {
  const allChannelNames = Object.keys(spec.channels);
  const channelServices = allChannelNames
    .filter((name) => spec.channels[name].enabled)
    .map((name) => renderChannelComposeService(name, spec.channels[name]))
    .join("\n");

  return [
    "services:",
    "  caddy:",
    "    image: caddy:2-alpine",
    "    restart: unless-stopped",
    "    ports:",
    "      - \"${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:80:80\"",
    "      - \"${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:443:443\"",
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
    "      - ${OPENPALM_STATE_HOME}/postgres/.env",
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
    "      - ${OPENPALM_STATE_HOME}/qdrant/.env",
    "    volumes:",
    "      - ${OPENPALM_DATA_HOME}/qdrant:/qdrant/storage",
    "    networks: [assistant_net]",
    "",
    "  openmemory:",
    "    image: mem0/openmemory-mcp:latest",
    "    restart: unless-stopped",
    "    env_file:",
    "      - ${OPENPALM_STATE_HOME}/openmemory/.env",
    "    ports:",
    "      - \"${OPENPALM_OPENMEMORY_BIND_ADDRESS:-127.0.0.1}:8765:8765\"",
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
    "      - \"${OPENPALM_OPENMEMORY_UI_BIND_ADDRESS:-127.0.0.1}:3000:3000\"",
    "    networks: [assistant_net]",
    "    depends_on: [openmemory]",
    "",
    "  opencode-core:",
    "    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/opencode-core:${OPENPALM_IMAGE_TAG:-latest}",
    "    restart: unless-stopped",
    "    env_file:",
    "      - ${OPENPALM_STATE_HOME}/opencode-core/.env",
    "    environment:",
    "      - OPENCODE_CONFIG_DIR=/opt/opencode",
    "      - OPENCODE_PORT=4096",
    "      - OPENCODE_ENABLE_SSH=${OPENCODE_ENABLE_SSH:-0}",
    "      - HOME=/home/opencode",
    "    ports:",
    "      - \"${OPENCODE_CORE_BIND_ADDRESS:-127.0.0.1}:4096:4096\"",
    "      - \"${OPENCODE_CORE_SSH_BIND_ADDRESS:-127.0.0.1}:${OPENCODE_CORE_SSH_PORT:-2222}:22\"",
    "    volumes:",
    "      - ${OPENPALM_DATA_HOME}/assistant:/home/opencode",
    "      - ${HOME}/openpalm:/work",
    "    working_dir: /work",
    "    user: \"${OPENPALM_UID:-1000}:${OPENPALM_GID:-1000}\"",
    "    networks: [assistant_net]",
    "    depends_on: [openmemory]",
    "    healthcheck:",
    "      test: [\"CMD\", \"curl\", \"-fs\", \"http://localhost:4096/\"]",
    "      interval: 30s",
    "      timeout: 10s",
    "      retries: 5",
    "      start_period: 30s",
    "",
    "  gateway:",
    "    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/gateway:${OPENPALM_IMAGE_TAG:-latest}",
    "    restart: unless-stopped",
    "    env_file:",
    "      - ${OPENPALM_STATE_HOME}/gateway/.env",
    "    environment:",
    "      - PORT=8080",
    "      - OPENCODE_CORE_BASE_URL=http://opencode-core:4096",
    "      - OPENCODE_TIMEOUT_MS=${OPENCODE_TIMEOUT_MS:-15000}",
    "    volumes:",
    "      - ${OPENPALM_STATE_HOME}/gateway:/app/data",
    "    networks: [assistant_net]",
    "    depends_on: [opencode-core]",
    "    healthcheck:",
    "      test: [\"CMD\", \"curl\", \"-fs\", \"http://localhost:8080/health\"]",
    "      interval: 30s",
    "      timeout: 5s",
    "      retries: 3",
    "      start_period: 10s",
    "",
    "  admin:",
    "    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:${OPENPALM_IMAGE_TAG:-latest}",
    "    restart: unless-stopped",
    "    environment:",
    "      - PORT=8100",
    "      - ADMIN_TOKEN=${ADMIN_TOKEN:-change-me-admin-token}",
    "      - GATEWAY_URL=http://gateway:8080",
    "      - OPENCODE_CORE_URL=http://opencode-core:4096",
    "      - OPENPALM_COMPOSE_BIN=${OPENPALM_COMPOSE_BIN:-docker}",
    "      - OPENPALM_COMPOSE_SUBCOMMAND=${OPENPALM_COMPOSE_SUBCOMMAND:-compose}",
    "      - OPENPALM_CONTAINER_SOCKET_URI=${OPENPALM_CONTAINER_SOCKET_URI:-unix:///var/run/docker.sock}",
    "    volumes:",
    "      - ${OPENPALM_DATA_HOME}:/data",
    "      - ${OPENPALM_CONFIG_HOME}:/config",
    "      - ${OPENPALM_STATE_HOME}:/state",
    "      - ${HOME}/openpalm:/work",
    "      - ${OPENPALM_CONTAINER_SOCKET_PATH:-/var/run/docker.sock}:${OPENPALM_CONTAINER_SOCKET_IN_CONTAINER:-/var/run/docker.sock}",
    "    networks: [assistant_net]",
    "    depends_on: [gateway, opencode-core]",
    "    healthcheck:",
    "      test: [\"CMD\", \"curl\", \"-fs\", \"http://localhost:8100/health\"]",
    "      interval: 30s",
    "      timeout: 5s",
    "      retries: 3",
    "      start_period: 10s",
    "",
    ...(channelServices.length > 0 ? [channelServices.trimEnd(), ""] : []),
    "networks:",
    "  assistant_net:",
    "",
  ].join("\n");
}

export function generateStackArtifacts(spec: StackSpec, secrets: Record<string, string>): GeneratedStackArtifacts {
  const lanMatcher = renderLanMatcher(spec.accessScope);
  const channelRoutes: Record<string, string> = {};

  for (const name of Object.keys(spec.channels)) {
    const route = renderChannelRoute(name, spec);
    if (route.length > 0) channelRoutes[`channels/${name}.caddy`] = route;
  }

  const domainBlocks = renderDomainBlocks(spec);

  const globalBlock: string[] = ["{", "\tadmin off"];
  if (spec.caddy?.email) {
    globalBlock.push(`\temail ${spec.caddy.email}`);
  }
  globalBlock.push("}");

  const caddyfileParts: string[] = [
    globalBlock.join("\n"),
    "",
  ];

  if (domainBlocks.length > 0) {
    caddyfileParts.push(domainBlocks);
    caddyfileParts.push("");
  }

  caddyfileParts.push(
    ":80 {",
    `\t@lan remote_ip ${lanMatcher}`,
    `\t@not_lan not remote_ip ${lanMatcher}`,
    "\t@host remote_ip 127.0.0.0/8 ::1",
    "\t@not_host not remote_ip 127.0.0.0/8 ::1",
    "",
    "\timport /etc/caddy/snippets/admin.caddy",
    "\timport /etc/caddy/snippets/channels/*.caddy",
    "\timport /etc/caddy/snippets/extra-user-overrides.caddy",
    "}",
    "",
  );

  const caddyfile = caddyfileParts.join("\n");
  const caddyJson = `${JSON.stringify({
    admin: { disabled: true },
    apps: { http: { servers: { openpalm: { listen: [":80"], routes: [] } } } },
  }, null, 2)}\n`;

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

  const channelEnvs: Record<string, string> = {};
  for (const [name, cfg] of Object.entries(spec.channels)) {
    if (!cfg.enabled) continue;
    const svcName = `channel-${composeServiceName(name)}`;
    channelEnvs[svcName] = envWithHeader(
      `# Generated channel env (${name})`,
      resolveChannelConfig(name, cfg, secrets),
    );
  }

  const gatewayChannelSecrets: Record<string, string> = {};
  for (const name of BuiltInChannelNames) {
    const secretEnvKey = BuiltInChannelSharedSecretEnv[name];
    gatewayChannelSecrets[secretEnvKey] = resolveChannelConfig(name, spec.channels[name], secrets)[secretEnvKey] ?? "";
  }

  const gatewayEnv = envWithHeader("# Generated gateway env", {
    ...pickEnvByPrefixes(secrets, ["OPENPALM_GATEWAY_", "GATEWAY_", "OPENPALM_SMALL_MODEL_API_KEY", "ANTHROPIC_API_KEY"]),
    ...gatewayChannelSecrets,
  });

  return {
    caddyfile,
    caddyJson,
    caddyRoutes,
    composeFile: renderFullComposeFile(spec),
    gatewayEnv,
    openmemoryEnv: envWithHeader("# Generated openmemory env", pickEnvByKeys(secrets, ["OPENAI_BASE_URL", "OPENAI_API_KEY"])),
    postgresEnv: envWithHeader("# Generated postgres env", pickEnvByKeys(secrets, ["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"])),
    qdrantEnv: envWithHeader("# Generated qdrant env", {}),
    opencodeEnv: envWithHeader("# Generated opencode env", {
      ...pickEnvByPrefixes(secrets, ["OPENPALM_SMALL_MODEL_API_KEY", "ANTHROPIC_API_KEY"]),
    }),
    channelEnvs,
  };
}
