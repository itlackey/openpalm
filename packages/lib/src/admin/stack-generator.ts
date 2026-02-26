import { parseSecretReference, isBuiltInChannel, BuiltInChannelPorts, getBuiltInChannelDef } from "./stack-spec.ts";
import type { StackChannelConfig, StackSpec } from "./stack-spec.ts";
import { renderCaddyComposeService, renderOpenMemoryComposeService, renderOpenMemoryUiComposeService, renderPostgresComposeService, renderQdrantComposeService } from "./core-services.ts";
import YAML from "yaml";
import type { ComposeService, ComposeSpec } from "./compose-spec.ts";

function composeServiceName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

function resolveChannelPort(name: string, config: StackChannelConfig): number {
  if (config.containerPort) return config.containerPort;
  if (isBuiltInChannel(name)) return BuiltInChannelPorts[name];
  throw new Error(`missing_container_port_for_channel_${name}`);
}

function resolveChannelImage(name: string, config: StackChannelConfig): string {
  if (config.image) return config.image;
  if (isBuiltInChannel(name)) return `\${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-${name}:\${OPENPALM_IMAGE_TAG:-latest}`;
  throw new Error(`missing_image_for_channel_${name}`);
}

function publishedChannelPort(name: string, config: StackChannelConfig): string {
  const containerPort = resolveChannelPort(name, config);
  const hostPort = config.hostPort ?? containerPort;
  return config.exposure === "host" ? `127.0.0.1:${hostPort}:${containerPort}` : `${hostPort}:${containerPort}`;
}

type GeneratedStackArtifacts = {
  caddyJson: string;
  composeFile: string;
  systemEnv: string;
  gatewayEnv: string;
  openmemoryEnv: string;
  postgresEnv: string;
  qdrantEnv: string;
  assistantEnv: string;
  channelEnvs: Record<string, string>;
};

type CaddyRoute = {
  match?: Array<Record<string, unknown>>;
  handle: Array<Record<string, unknown>>;
  terminal?: boolean;
};

type CaddyServer = {
  listen: string[];
  routes: CaddyRoute[];
};

type CaddyJsonConfig = {
  admin: { disabled: boolean };
  apps: { http: { servers: Record<string, CaddyServer> } };
};

function renderLanRanges(scope: StackSpec["accessScope"]): string[] {
  if (scope === "host") return ["127.0.0.0/8", "::1"];
  return ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "::1", "fd00::/8"];
}

function guardRoute(ranges: string[]): CaddyRoute {
  return {
    match: [{ not: [{ remote_ip: { ranges } }] }],
    handle: [{ handler: "static_response", status_code: "403", headers: { Connection: ["close"] } }],
    terminal: true,
  };
}

function caddyGuardedProxy(guardRanges: string[], upstream: string): CaddyRoute {
  return {
    handle: [{
      handler: "subroute",
      routes: [
        guardRoute(guardRanges),
        { handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }] },
      ],
    }],
  };
}

function caddyStripPrefixProxy(pathPrefix: string, upstream: string): CaddyRoute {
  return {
    match: [{ path: [`${pathPrefix}*`] }],
    handle: [
      { handler: "rewrite", strip_path_prefix: pathPrefix },
      { handler: "reverse_proxy", upstreams: [{ dial: upstream }] },
    ],
    terminal: true,
  };
}

function caddyAdminSubroute(guardRanges: string[]): CaddyRoute {
  return {
    match: [{ path: ["/api*", "/services/opencode*", "/services/openmemory*"] }],
    handle: [{
      handler: "subroute",
      routes: [
        guardRoute(guardRanges),
        caddyStripPrefixProxy("/api", "admin:8100"),
        caddyStripPrefixProxy("/services/opencode", "assistant:4096"),
        caddyStripPrefixProxy("/services/openmemory", "openmemory-ui:3000"),
      ],
    }],
    terminal: true,
  };
}

function caddyChannelRoute(name: string, cfg: StackChannelConfig, guardRanges: string[]): CaddyRoute | null {
  if (!cfg.enabled) return null;
  const upstream = `channel-${composeServiceName(name)}:${resolveChannelPort(name, cfg)}`;
  const rewritePath = cfg.rewritePath ?? (isBuiltInChannel(name) ? getBuiltInChannelDef(name).rewritePath : undefined);
  const rewriteHandler = rewritePath
    ? { handler: "rewrite", uri: rewritePath }
    : { handler: "rewrite", strip_path_prefix: `/channels/${name}` };
  const routes: CaddyRoute[] = [];
  if (cfg.exposure === "lan" || cfg.exposure === "host") {
    routes.push(guardRoute(cfg.exposure === "host" ? ["127.0.0.0/8", "::1"] : guardRanges));
  }
  routes.push({ handle: [rewriteHandler, { handler: "reverse_proxy", upstreams: [{ dial: upstream }] }] });
  return { match: [{ path: [`/channels/${name}*`] }], handle: [{ handler: "subroute", routes }], terminal: true };
}

function renderCaddyJsonConfig(spec: StackSpec): CaddyJsonConfig {
  const guardRanges = renderLanRanges(spec.accessScope);
  const channelRoutes: CaddyRoute[] = [];
  for (const [name, cfg] of Object.entries(spec.channels)) {
    const route = caddyChannelRoute(name, cfg, guardRanges);
    if (route) channelRoutes.push(route);
  }
  const mainRoutes: CaddyRoute[] = [
    caddyAdminSubroute(guardRanges),
    ...channelRoutes,
    caddyGuardedProxy(guardRanges, "assistant:4096"),
  ];

  return {
    admin: { disabled: true },
    apps: { http: { servers: { main: { listen: [`:${spec.ingressPort ?? 80}`], routes: mainRoutes } } } },
  };
}

function envWithHeader(header: string, entries: Record<string, string>): string {
  const lines = [header];
  for (const [key, value] of Object.entries(entries)) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

function pickEnv(secrets: Record<string, string>, keys: string[], prefixes?: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) result[key] = secrets[key] ?? "";
  if (prefixes) {
    for (const [key, value] of Object.entries(secrets)) {
      if (prefixes.some((p) => key.startsWith(p))) result[key] = value;
    }
  }
  return result;
}

function resolveScalar(value: string, secrets: Record<string, string>, fieldName: string): string {
  const ref = parseSecretReference(value);
  if (!ref) return value;
  if (secrets[ref] === undefined || secrets[ref].length === 0) throw new Error(`unresolved_secret_reference_${fieldName}_${ref}`);
  return secrets[ref];
}

function renderChannelComposeService(name: string, config: StackChannelConfig): ComposeService {
  const svcName = `channel-${composeServiceName(name)}`;
  const image = resolveChannelImage(name, config);
  const containerPort = resolveChannelPort(name, config);
  const portBinding = publishedChannelPort(name, config);
  const healthcheckPath = config.healthcheckPath ?? "/health";

  return {
    image,
    restart: "unless-stopped",
    env_file: [`${"${OPENPALM_STATE_HOME}"}/${svcName}/.env`],
    environment: [
      `PORT=${containerPort}`,
      "GATEWAY_URL=http://gateway:8080",
    ],
    ports: [portBinding],
    networks: ["channel_net"],
    depends_on: { gateway: { condition: "service_healthy" } },
    healthcheck: {
      test: ["CMD-SHELL", `curl -sf http://localhost:${containerPort}${healthcheckPath} || exit 1`],
      interval: "10s",
      timeout: "5s",
      retries: 3,
    },
  };
}

function renderAssistantComposeService(): ComposeService {
  return {
    image: "${OPENPALM_IMAGE_NAMESPACE:-openpalm}/assistant:${OPENPALM_IMAGE_TAG:-latest}",
    restart: "unless-stopped",
    env_file: ["${OPENPALM_STATE_HOME}/assistant/.env"],
    environment: [
      "OPENCODE_CONFIG_DIR=/opt/opencode",
      "OPENCODE_PORT=4096",
      "OPENCODE_AUTH=false",
      "OPENCODE_ENABLE_SSH=${OPENCODE_ENABLE_SSH:-0}",
      "OPENPALM_ADMIN_API_URL=http://admin:8100",
      "OPENPALM_ADMIN_TOKEN=${ADMIN_TOKEN:?ADMIN_TOKEN must be set}",
      "HOME=/home/opencode",
    ],
    ports: [
      "${OPENPALM_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:4096:4096",
      "${OPENPALM_ASSISTANT_SSH_BIND_ADDRESS:-127.0.0.1}:${OPENPALM_ASSISTANT_SSH_PORT:-2222}:22",
    ],
    volumes: [
      "${OPENPALM_DATA_HOME}/assistant:/home/opencode",
      "${OPENPALM_WORK_HOME:-${HOME}/openpalm}:/work",
    ],
    working_dir: "/work",
    user: "${OPENPALM_UID:-1000}:${OPENPALM_GID:-1000}",
    networks: ["assistant_net"],
    depends_on: { openmemory: { condition: "service_healthy" } },
    healthcheck: {
      test: ["CMD", "curl", "-fs", "http://localhost:4096/"],
      interval: "30s",
      timeout: "10s",
      retries: 5,
      start_period: "30s",
    },
  };
}

function renderGatewayComposeService(): ComposeService {
  return {
    image: "${OPENPALM_IMAGE_NAMESPACE:-openpalm}/gateway:${OPENPALM_IMAGE_TAG:-latest}",
    restart: "unless-stopped",
    env_file: [
      "${OPENPALM_STATE_HOME}/system.env",
      "${OPENPALM_STATE_HOME}/gateway/.env",
    ],
    environment: [
      "PORT=8080",
      "OPENPALM_ASSISTANT_URL=http://assistant:4096",
      "OPENCODE_TIMEOUT_MS=${OPENCODE_TIMEOUT_MS:-15000}",
    ],
    volumes: [
      "${OPENPALM_STATE_HOME}/gateway:/app/data",
      "${OPENPALM_STATE_HOME}:/state:ro",
    ],
    user: "${OPENPALM_UID:-1000}:${OPENPALM_GID:-1000}",
    networks: ["channel_net", "assistant_net"],
    depends_on: { assistant: { condition: "service_healthy" } },
    healthcheck: {
      test: ["CMD", "curl", "-fs", "http://localhost:8080/health"],
      interval: "30s",
      timeout: "5s",
      retries: 3,
      start_period: "10s",
    },
  };
}

function renderAdminComposeService(): ComposeService {
  return {
    image: "${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:${OPENPALM_IMAGE_TAG:-latest}",
    restart: "unless-stopped",
    env_file: ["${OPENPALM_STATE_HOME}/system.env"],
    environment: [
      "PORT=8100",
      "ADMIN_TOKEN=${ADMIN_TOKEN:?ADMIN_TOKEN must be set}",
      "GATEWAY_URL=http://gateway:8080",
      "OPENPALM_ASSISTANT_URL=http://assistant:4096",
      "OPENPALM_COMPOSE_BIN=${OPENPALM_COMPOSE_BIN:-docker}",
      "OPENPALM_COMPOSE_SUBCOMMAND=${OPENPALM_COMPOSE_SUBCOMMAND:-compose}",
      "COMPOSE_PROJECT_PATH=/state",
      "OPENPALM_COMPOSE_FILE=docker-compose.yml",
    ],
    volumes: [
      "${OPENPALM_DATA_HOME}:/data",
      "${OPENPALM_CONFIG_HOME}:/config",
      "${OPENPALM_STATE_HOME}:/state",
      "${OPENPALM_WORK_HOME:-${HOME}/openpalm}:/work",
      "${OPENPALM_CONTAINER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock:ro",
    ],
    networks: ["assistant_net"],
    depends_on: {
      gateway: { condition: "service_healthy" },
    },
    healthcheck: {
      test: ["CMD", "curl", "-fs", "http://localhost:8100/health"],
      interval: "30s",
      timeout: "5s",
      retries: 3,
      start_period: "10s",
    },
  };
}

function renderFullComposeFile(spec: StackSpec): string {
  const services: Record<string, ComposeService> = {
    caddy: renderCaddyComposeService(),
    postgres: renderPostgresComposeService(),
    qdrant: renderQdrantComposeService(),
    openmemory: renderOpenMemoryComposeService(),
    "openmemory-ui": renderOpenMemoryUiComposeService(),
    assistant: renderAssistantComposeService(),
    gateway: renderGatewayComposeService(),
    admin: renderAdminComposeService(),
  };

  for (const name of Object.keys(spec.channels)) {
    if (!spec.channels[name].enabled) continue;
    const svcName = `channel-${composeServiceName(name)}`;
    services[svcName] = renderChannelComposeService(name, spec.channels[name]);
  }

  const specDoc: ComposeSpec = {
    services,
    networks: { channel_net: {}, assistant_net: {} },
  };

  return YAML.stringify(specDoc, { indent: 2, sortMapEntries: true });
}

function generateChannelEnvs(spec: StackSpec, secrets: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, cfg] of Object.entries(spec.channels)) {
    if (!cfg.enabled) continue;
    const svcName = `channel-${composeServiceName(name)}`;
    const channelEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(cfg.config)) channelEnv[key] = resolveScalar(value, secrets, `${name}_${key}`);
    result[svcName] = envWithHeader(`# Generated channel env (${name})`, channelEnv);
  }
  return result;
}

export function generateStackArtifacts(spec: StackSpec, secrets: Record<string, string>): GeneratedStackArtifacts {
  const enabledChannels = Object.keys(spec.channels)
    .filter((name) => spec.channels[name].enabled)
    .map((name) => `channel-${composeServiceName(name)}`)
    .join(",");

  return {
    caddyJson: JSON.stringify(renderCaddyJsonConfig(spec), null, 2) + "\n",
    composeFile: renderFullComposeFile(spec),
    systemEnv: envWithHeader("# Generated system env — do not edit; regenerated on every stack apply", {
      OPENPALM_ACCESS_SCOPE: spec.accessScope,
      OPENPALM_ENABLED_CHANNELS: enabledChannels,
    }),
    gatewayEnv: envWithHeader("# Generated gateway env", pickEnv(secrets, [], ["OPENPALM_GATEWAY_", "GATEWAY_", "OPENPALM_SMALL_MODEL_API_KEY", "ANTHROPIC_API_KEY"])),
    openmemoryEnv: envWithHeader("# Generated openmemory env", pickEnv(secrets, ["OPENAI_BASE_URL", "OPENAI_API_KEY"])),
    postgresEnv: envWithHeader("# Generated postgres env", pickEnv(secrets, ["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"])),
    qdrantEnv: envWithHeader("# Generated qdrant env", {}),
    assistantEnv: envWithHeader("# Generated assistant env", pickEnv(secrets, ["OPENPALM_PROFILE_NAME", "OPENPALM_PROFILE_EMAIL"], ["OPENPALM_SMALL_MODEL_API_KEY", "ANTHROPIC_API_KEY"])),
    channelEnvs: generateChannelEnvs(spec, secrets),
  };
}
