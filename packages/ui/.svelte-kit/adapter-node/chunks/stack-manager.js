import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { Y as YAML, B as BUILTIN_CHANNELS } from "./index.js";
import { a as parseSecretReference, i as isBuiltInChannel, B as BuiltInChannelPorts, g as getBuiltInChannelDef, e as ensureStackSpec, p as parseStackSpec, s as stringifyStackSpec } from "./stack-spec.js";
import { s as sanitizeEnvScalar, u as updateRuntimeEnvContent, p as parseRuntimeEnvContent } from "./runtime-env.js";
import { v as validateCron } from "./cron.js";
function composeServiceName(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}
function renderCaddyComposeService() {
  return {
    image: "caddy:2-alpine",
    restart: "unless-stopped",
    ports: [
      "${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:${OPENPALM_INGRESS_PORT:-80}:80",
      "${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:443:443"
    ],
    volumes: [
      "${OPENPALM_STATE_HOME}/caddy.json:/etc/caddy/caddy.json:ro",
      "${OPENPALM_STATE_HOME}/caddy/data:/data/caddy",
      "${OPENPALM_STATE_HOME}/caddy/config:/config/caddy"
    ],
    command: "caddy run --config /etc/caddy/caddy.json",
    healthcheck: {
      test: ["CMD-SHELL", "curl -sf http://localhost:80/ || exit 1"],
      interval: "10s",
      timeout: "5s",
      retries: 5
    },
    networks: ["assistant_net", "channel_net"]
  };
}
function renderPostgresComposeService() {
  return {
    image: "postgres:18.2-alpine",
    restart: "unless-stopped",
    env_file: ["${OPENPALM_STATE_HOME}/postgres/.env"],
    environment: {
      POSTGRES_DB: "${POSTGRES_DB:-openpalm}",
      POSTGRES_USER: "${POSTGRES_USER:-openpalm}",
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
    },
    volumes: ["${OPENPALM_DATA_HOME}/postgres:/var/lib/postgresql/data"],
    networks: ["assistant_net"],
    healthcheck: {
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-openpalm}"],
      interval: "10s",
      timeout: "5s",
      retries: 5
    }
  };
}
function renderQdrantComposeService() {
  return {
    image: "qdrant/qdrant:v1.17",
    restart: "unless-stopped",
    env_file: ["${OPENPALM_STATE_HOME}/qdrant/.env"],
    volumes: ["${OPENPALM_DATA_HOME}/qdrant:/qdrant/storage"],
    networks: ["assistant_net"],
    healthcheck: {
      test: ["CMD-SHELL", "curl -sf http://localhost:6333/readyz || exit 1"],
      interval: "10s",
      timeout: "5s",
      retries: 5
    }
  };
}
function renderOpenMemoryComposeService() {
  return {
    image: "mem0/openmemory-mcp:latest@sha256:b665d382a94fdc18c7bb84a647d4bebdc98d9e7fc1146fc5e559ca7f5f7f9211",
    restart: "unless-stopped",
    env_file: ["${OPENPALM_STATE_HOME}/openmemory/.env"],
    ports: ["${OPENPALM_OPENMEMORY_BIND_ADDRESS:-127.0.0.1}:8765:8765"],
    volumes: ["${OPENPALM_DATA_HOME}/openmemory:/data"],
    networks: ["assistant_net"],
    depends_on: {
      qdrant: { condition: "service_healthy" },
      postgres: { condition: "service_healthy" }
    },
    healthcheck: {
      test: ["CMD-SHELL", "curl -sf http://localhost:8765/ || exit 1"],
      interval: "15s",
      timeout: "10s",
      retries: 5
    }
  };
}
function renderOpenMemoryUiComposeService() {
  return {
    image: "mem0/openmemory-ui:latest@sha256:c4b9578335a5cad2866f69d836476dde8ab30cdc6c181702c91a4c094cd29a2b",
    restart: "unless-stopped",
    environment: [
      "NEXT_PUBLIC_API_URL=${OPENMEMORY_DASHBOARD_API_URL:-http://localhost:8765}",
      "NEXT_PUBLIC_USER_ID=${OPENMEMORY_USER_ID:-default-user}"
    ],
    ports: ["${OPENPALM_OPENMEMORY_DASHBOARD_BIND_ADDRESS:-127.0.0.1}:3001:3000"],
    networks: ["assistant_net"],
    depends_on: {
      openmemory: { condition: "service_healthy" }
    },
    healthcheck: {
      test: ["CMD-SHELL", "curl -sf http://localhost:3000/ || exit 1"],
      interval: "10s",
      timeout: "5s",
      retries: 5
    }
  };
}
function stringifyComposeSpec(spec) {
  return YAML.stringify(spec, { indent: 2, sortMapEntries: true });
}
function resolveChannelPort(name, config) {
  if (config.containerPort) return config.containerPort;
  if (isBuiltInChannel(name)) return BuiltInChannelPorts[name];
  throw new Error(`missing_container_port_for_channel_${name}`);
}
function resolveChannelHostPort(name, config) {
  if (config.hostPort) return config.hostPort;
  return resolveChannelPort(name, config);
}
function resolveChannelImage(name, config) {
  if (config.image) return config.image;
  if (isBuiltInChannel(name)) {
    return `\${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-${name}:\${OPENPALM_IMAGE_TAG:-latest}`;
  }
  throw new Error(`missing_image_for_channel_${name}`);
}
function publishedChannelPort(name, config) {
  const containerPort = resolveChannelPort(name, config);
  const hostPort = resolveChannelHostPort(name, config);
  if (config.exposure === "host") {
    return `127.0.0.1:${hostPort}:${containerPort}`;
  }
  return `${hostPort}:${containerPort}`;
}
function renderLanRanges(scope) {
  if (scope === "host") return ["127.0.0.0/8", "::1"];
  return ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "::1", "fd00::/8"];
}
function caddyGuardHandler() {
  return {
    handler: "static_response",
    status_code: "403",
    headers: { Connection: ["close"] }
  };
}
function caddyGuardMatcher(ranges, negate) {
  {
    return { not: [{ remote_ip: { ranges } }] };
  }
}
function caddyHostRoute(hostname, upstream, guardRanges) {
  return {
    match: [{ host: [hostname] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            match: [caddyGuardMatcher(guardRanges)],
            handle: [caddyGuardHandler()],
            terminal: true
          },
          {
            handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }]
          }
        ]
      }
    ],
    terminal: true
  };
}
function caddyAdminSubroute(guardRanges) {
  return {
    match: [{ path: ["/api*", "/services/opencode*", "/services/openmemory*"] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          // Guard: block non-LAN
          {
            match: [caddyGuardMatcher(guardRanges)],
            handle: [caddyGuardHandler()],
            terminal: true
          },
          // /api* → strip API prefix and proxy to admin:8100
          {
            match: [{ path: ["/api*"] }],
            handle: [
              { handler: "rewrite", strip_path_prefix: "/api" },
              { handler: "reverse_proxy", upstreams: [{ dial: "admin:8100" }] }
            ],
            terminal: true
          },
          // /services/opencode* → strip prefix + proxy to assistant:4096
          {
            match: [{ path: ["/services/opencode*"] }],
            handle: [
              { handler: "rewrite", strip_path_prefix: "/services/opencode" },
              { handler: "reverse_proxy", upstreams: [{ dial: "assistant:4096" }] }
            ],
            terminal: true
          },
          // /services/openmemory* → strip prefix + proxy to openmemory-ui:3000
          {
            match: [{ path: ["/services/openmemory*"] }],
            handle: [
              { handler: "rewrite", strip_path_prefix: "/services/openmemory" },
              { handler: "reverse_proxy", upstreams: [{ dial: "openmemory-ui:3000" }] }
            ],
            terminal: true
          }
        ]
      }
    ],
    terminal: true
  };
}
function caddyChannelRoute(name, cfg, spec) {
  if (!cfg.enabled) return null;
  if (cfg.domains && cfg.domains.length > 0) return null;
  const containerPort = resolveChannelPort(name, cfg);
  const svcName = `channel-${composeServiceName(name)}`;
  const guardRanges = renderLanRanges(spec.accessScope);
  const subrouteHandlers = [];
  if (cfg.exposure === "lan" || cfg.exposure === "host") {
    const ranges = cfg.exposure === "host" ? ["127.0.0.0/8", "::1"] : guardRanges;
    subrouteHandlers.push({
      match: [caddyGuardMatcher(ranges)],
      handle: [caddyGuardHandler()],
      terminal: true
    });
  }
  const rewritePath = cfg.rewritePath ?? (isBuiltInChannel(name) ? getBuiltInChannelDef(name).rewritePath : void 0);
  if (rewritePath) {
    subrouteHandlers.push({
      handle: [
        { handler: "rewrite", uri: rewritePath },
        { handler: "reverse_proxy", upstreams: [{ dial: `${svcName}:${containerPort}` }] }
      ]
    });
  } else {
    subrouteHandlers.push({
      handle: [
        { handler: "rewrite", strip_path_prefix: `/channels/${name}` },
        { handler: "reverse_proxy", upstreams: [{ dial: `${svcName}:${containerPort}` }] }
      ]
    });
  }
  return {
    match: [{ path: [`/channels/${name}*`] }],
    handle: [{ handler: "subroute", routes: subrouteHandlers }],
    terminal: true
  };
}
function caddyDomainRoute(domain, svcName, port, cfg, spec) {
  const guardRanges = renderLanRanges(spec.accessScope);
  const subrouteHandlers = [];
  if (cfg.exposure === "lan" || cfg.exposure === "host") {
    const ranges = cfg.exposure === "host" ? ["127.0.0.0/8", "::1"] : guardRanges;
    subrouteHandlers.push({
      match: [caddyGuardMatcher(ranges)],
      handle: [caddyGuardHandler()],
      terminal: true
    });
  }
  const paths = cfg.pathPrefixes?.length ? cfg.pathPrefixes : ["/"];
  for (const p of paths) {
    const prefix = p.startsWith("/") ? p : `/${p}`;
    if (prefix === "/" || prefix === "/*") {
      subrouteHandlers.push({
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `${svcName}:${port}` }] }]
      });
    } else {
      subrouteHandlers.push({
        match: [{ path: [`${prefix}*`] }],
        handle: [
          { handler: "rewrite", strip_path_prefix: prefix },
          { handler: "reverse_proxy", upstreams: [{ dial: `${svcName}:${port}` }] }
        ],
        terminal: true
      });
    }
  }
  return [{
    match: [{ host: cfg.domains }],
    handle: [{ handler: "subroute", routes: subrouteHandlers }],
    terminal: true
  }];
}
function renderCaddyJsonConfig(spec) {
  const guardRanges = renderLanRanges(spec.accessScope);
  const mainRoutes = [];
  const domainRoutes = [];
  mainRoutes.push(caddyHostRoute("localhost", "admin:8100", guardRanges));
  mainRoutes.push(caddyAdminSubroute(guardRanges));
  for (const [name, cfg] of Object.entries(spec.channels)) {
    if (!cfg.enabled) continue;
    if (cfg.domains && cfg.domains.length > 0) {
      const containerPort = resolveChannelPort(name, cfg);
      const svcName = `channel-${composeServiceName(name)}`;
      domainRoutes.push(...caddyDomainRoute(cfg.domains[0], svcName, containerPort, cfg, spec));
      continue;
    }
    const route = caddyChannelRoute(name, cfg, spec);
    if (route) mainRoutes.push(route);
  }
  mainRoutes.push({
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            match: [caddyGuardMatcher(guardRanges)],
            handle: [caddyGuardHandler()],
            terminal: true
          },
          {
            handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "admin:8100" }] }]
          }
        ]
      }
    ]
  });
  const servers = {
    main: {
      listen: [`:${spec.ingressPort ?? 80}`],
      routes: mainRoutes
    }
  };
  if (domainRoutes.length > 0) {
    servers.tls_domains = {
      listen: [":443"],
      routes: domainRoutes
    };
  }
  const config = {
    admin: { disabled: true },
    apps: {
      http: { servers }
    }
  };
  if (spec.caddy?.email) {
    config.apps.tls = {
      automation: {
        policies: [{
          issuers: [{
            module: "acme",
            email: spec.caddy.email
          }]
        }]
      }
    };
  }
  return config;
}
function envWithHeader(header, entries) {
  const lines = [header];
  for (const [key, value] of Object.entries(entries)) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}
`;
}
function pickEnvByPrefixes(secrets, prefixes) {
  const result = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) result[key] = value;
  }
  return result;
}
function pickEnvByKeys(secrets, keys) {
  const result = {};
  for (const key of keys) result[key] = secrets[key] ?? "";
  return result;
}
function resolveScalar(value, secrets, fieldName) {
  const ref = parseSecretReference(value);
  if (!ref) return value;
  if (secrets[ref] === void 0 || secrets[ref].length === 0) throw new Error(`unresolved_secret_reference_${fieldName}_${ref}`);
  return secrets[ref];
}
function resolveChannelConfig(name, cfg, secrets) {
  const channelEnv = {};
  for (const [key, value] of Object.entries(cfg.config)) {
    channelEnv[key] = resolveScalar(value, secrets, `${name}_${key}`);
  }
  return channelEnv;
}
function renderChannelComposeService(name, config) {
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
      "GATEWAY_URL=http://gateway:8080"
    ],
    ports: [portBinding],
    networks: ["channel_net"],
    depends_on: { gateway: { condition: "service_healthy" } },
    healthcheck: {
      test: ["CMD-SHELL", `curl -sf http://localhost:${containerPort}${healthcheckPath} || exit 1`],
      interval: "10s",
      timeout: "5s",
      retries: 3
    }
  };
}
function renderAssistantComposeService() {
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
      "HOME=/home/opencode"
    ],
    ports: [
      "${OPENPALM_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:4096:4096",
      "${OPENPALM_ASSISTANT_SSH_BIND_ADDRESS:-127.0.0.1}:${OPENPALM_ASSISTANT_SSH_PORT:-2222}:22"
    ],
    volumes: [
      "${OPENPALM_DATA_HOME}/assistant:/home/opencode",
      "${OPENPALM_WORK_HOME:-${HOME}/openpalm}:/work"
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
      start_period: "30s"
    }
  };
}
function renderGatewayComposeService() {
  return {
    image: "${OPENPALM_IMAGE_NAMESPACE:-openpalm}/gateway:${OPENPALM_IMAGE_TAG:-latest}",
    restart: "unless-stopped",
    env_file: [
      "${OPENPALM_STATE_HOME}/system.env",
      "${OPENPALM_STATE_HOME}/gateway/.env"
    ],
    environment: [
      "PORT=8080",
      "OPENPALM_ASSISTANT_URL=http://assistant:4096",
      "OPENCODE_TIMEOUT_MS=${OPENCODE_TIMEOUT_MS:-15000}"
    ],
    volumes: [
      "${OPENPALM_STATE_HOME}/gateway:/app/data",
      "${OPENPALM_STATE_HOME}:/state:ro"
    ],
    user: "${OPENPALM_UID:-1000}:${OPENPALM_GID:-1000}",
    networks: ["channel_net", "assistant_net"],
    depends_on: { assistant: { condition: "service_healthy" } },
    healthcheck: {
      test: ["CMD", "curl", "-fs", "http://localhost:8080/health"],
      interval: "30s",
      timeout: "5s",
      retries: 3,
      start_period: "10s"
    }
  };
}
function renderAdminComposeService() {
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
      "OPENPALM_CONTAINER_SOCKET_URI=${OPENPALM_CONTAINER_SOCKET_URI:-tcp://docker-proxy:2375}"
    ],
    volumes: [
      "${OPENPALM_DATA_HOME}:/data",
      "${OPENPALM_CONFIG_HOME}:/config",
      "${OPENPALM_STATE_HOME}:/state",
      "${OPENPALM_WORK_HOME:-${HOME}/openpalm}:/work"
    ],
    networks: ["assistant_net"],
    depends_on: {
      gateway: { condition: "service_healthy" },
      "docker-proxy": { condition: "service_started" }
    },
    healthcheck: {
      test: ["CMD", "curl", "-fs", "http://localhost:8100/health"],
      interval: "30s",
      timeout: "5s",
      retries: 3,
      start_period: "10s"
    }
  };
}
function renderDockerProxyComposeService() {
  return {
    image: "tecnativa/docker-socket-proxy:0.4.1",
    restart: "unless-stopped",
    environment: [
      "LOG_LEVEL=warning",
      "CONTAINERS=1",
      "IMAGES=1",
      "NETWORKS=1",
      "VOLUMES=1",
      "SERVICES=1",
      "TASKS=1",
      "POST=1",
      "AUTH=0",
      "SECRETS=0",
      "SWARM=0",
      "SYSTEM=0",
      "NODES=0",
      "PLUGINS=0",
      "SESSION=0",
      "EXEC=1",
      "BUILD=1",
      "COMMIT=0",
      "DISTRIBUTION=0",
      "ALLOW_START=1",
      "ALLOW_STOP=1",
      "ALLOW_RESTARTS=1"
    ],
    volumes: [
      "${OPENPALM_CONTAINER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock:ro"
    ],
    networks: ["assistant_net"]
  };
}
function renderServiceComposeService(name, config) {
  const svcName = `service-${composeServiceName(name)}`;
  const healthcheckPath = config.healthcheckPath ?? "/health";
  const service = {
    image: config.image,
    restart: "unless-stopped",
    env_file: [`${"${OPENPALM_STATE_HOME}"}/${svcName}/.env`],
    environment: [`PORT=${config.containerPort}`],
    healthcheck: {
      test: ["CMD-SHELL", `curl -sf http://localhost:${config.containerPort}${healthcheckPath} || exit 1`],
      interval: "10s",
      timeout: "5s",
      retries: 3
    },
    networks: ["assistant_net"]
  };
  if (config.volumes && config.volumes.length > 0) {
    service.volumes = [...config.volumes];
  }
  if (config.dependsOn && config.dependsOn.length > 0) {
    service.depends_on = Object.fromEntries(config.dependsOn.map((dep) => [dep, { condition: "service_healthy" }]));
  }
  return service;
}
function renderFullComposeFile(spec) {
  const services = {
    caddy: renderCaddyComposeService(),
    postgres: renderPostgresComposeService(),
    qdrant: renderQdrantComposeService(),
    openmemory: renderOpenMemoryComposeService(),
    "openmemory-ui": renderOpenMemoryUiComposeService(),
    assistant: renderAssistantComposeService(),
    gateway: renderGatewayComposeService(),
    "docker-proxy": renderDockerProxyComposeService(),
    admin: renderAdminComposeService()
  };
  for (const name of Object.keys(spec.channels)) {
    if (!spec.channels[name].enabled) continue;
    const svcName = `channel-${composeServiceName(name)}`;
    services[svcName] = renderChannelComposeService(name, spec.channels[name]);
  }
  for (const name of Object.keys(spec.services)) {
    if (!spec.services[name].enabled) continue;
    const svcName = `service-${composeServiceName(name)}`;
    services[svcName] = renderServiceComposeService(name, spec.services[name]);
  }
  const specDoc = {
    services,
    networks: { channel_net: {}, assistant_net: {} }
  };
  return stringifyComposeSpec(specDoc);
}
function generateStackArtifacts(spec, secrets) {
  const caddyConfig = renderCaddyJsonConfig(spec);
  const caddyJson = JSON.stringify(caddyConfig, null, 2) + "\n";
  const channelEnvs = {};
  for (const [name, cfg] of Object.entries(spec.channels)) {
    if (!cfg.enabled) continue;
    const svcName = `channel-${composeServiceName(name)}`;
    channelEnvs[svcName] = envWithHeader(
      `# Generated channel env (${name})`,
      resolveChannelConfig(name, cfg, secrets)
    );
  }
  const enabledChannels = Object.keys(spec.channels).filter((name) => spec.channels[name].enabled).map((name) => `channel-${composeServiceName(name)}`).join(",");
  const systemEnv = envWithHeader("# Generated system env — do not edit; regenerated on every stack apply", {
    OPENPALM_ACCESS_SCOPE: spec.accessScope,
    OPENPALM_ENABLED_CHANNELS: enabledChannels
  });
  const gatewayEnv = envWithHeader("# Generated gateway env", {
    ...pickEnvByPrefixes(secrets, ["OPENPALM_GATEWAY_", "GATEWAY_", "OPENPALM_SMALL_MODEL_API_KEY", "ANTHROPIC_API_KEY"])
  });
  const serviceEnvs = {};
  for (const [name, cfg] of Object.entries(spec.services)) {
    if (!cfg.enabled) continue;
    const svcName = `service-${composeServiceName(name)}`;
    const resolved = {};
    for (const [key, value] of Object.entries(cfg.config)) {
      resolved[key] = resolveScalar(value, secrets, `${name}_${key}`);
    }
    serviceEnvs[svcName] = envWithHeader(`# Generated service env (${name})`, resolved);
  }
  return {
    caddyJson,
    composeFile: renderFullComposeFile(spec),
    systemEnv,
    gatewayEnv,
    openmemoryEnv: envWithHeader("# Generated openmemory env", pickEnvByKeys(secrets, ["OPENAI_BASE_URL", "OPENAI_API_KEY"])),
    postgresEnv: envWithHeader("# Generated postgres env", pickEnvByKeys(secrets, ["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"])),
    qdrantEnv: envWithHeader("# Generated qdrant env", {}),
    assistantEnv: envWithHeader("# Generated assistant env", {
      ...pickEnvByPrefixes(secrets, ["OPENPALM_SMALL_MODEL_API_KEY", "ANTHROPIC_API_KEY"]),
      ...pickEnvByKeys(secrets, ["OPENPALM_PROFILE_NAME", "OPENPALM_PROFILE_EMAIL"])
    }),
    channelEnvs,
    serviceEnvs,
    renderReport: {
      applySafe: true,
      warnings: [],
      missingSecretReferences: [],
      changedArtifacts: []
    }
  };
}
const CoreSecretRequirements = [
  { service: "admin", key: "ADMIN_TOKEN", required: true },
  { service: "postgres", key: "POSTGRES_PASSWORD", required: true }
];
function nextInstanceName(baseName, used) {
  if (!used.has(baseName)) return baseName;
  let idx = 2;
  while (used.has(`${baseName}-${idx}`)) idx += 1;
  return `${baseName}-${idx}`;
}
function pickEnv(source, keys) {
  const out = {};
  for (const key of keys) {
    const value = source[key];
    if (value) out[key] = value;
  }
  return out;
}
class StackManager {
  constructor(paths) {
    this.paths = paths;
  }
  cachedSpec = null;
  artifactContentCache = /* @__PURE__ */ new Map();
  runtimeEnvCache = null;
  secretsFileMtimeMs = null;
  dataEnvFileMtimeMs = null;
  cachedSecrets = null;
  getPaths() {
    return { ...this.paths };
  }
  getSpec() {
    if (!this.cachedSpec) {
      this.cachedSpec = ensureStackSpec(this.paths.stackSpecPath);
    }
    return structuredClone(this.cachedSpec);
  }
  setSpec(raw) {
    const spec = parseStackSpec(raw);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    this.renderArtifacts();
    return spec;
  }
  getChannelAccess(channel) {
    const spec = this.getSpec();
    if (!spec.channels[channel]) throw new Error(`unknown_channel_${channel}`);
    return spec.channels[channel].exposure;
  }
  getChannelConfig(channel) {
    const spec = this.getSpec();
    if (!spec.channels[channel]) throw new Error(`unknown_channel_${channel}`);
    return { ...spec.channels[channel].config };
  }
  setChannelAccess(channel, access) {
    const spec = this.getSpec();
    if (!spec.channels[channel]) throw new Error(`unknown_channel_${channel}`);
    spec.channels[channel].enabled = true;
    spec.channels[channel].exposure = access;
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    return this.renderArtifacts();
  }
  setChannelConfig(channel, values) {
    const spec = this.getSpec();
    if (!spec.channels[channel]) throw new Error(`unknown_channel_${channel}`);
    const current = spec.channels[channel].config;
    if (isBuiltInChannel(channel)) {
      const next = {};
      for (const key of Object.keys(current)) {
        next[key] = sanitizeEnvScalar(values[key] ?? "");
      }
      spec.channels[channel].config = next;
    } else {
      const next = {};
      for (const key of Object.keys(values)) {
        next[key] = sanitizeEnvScalar(values[key] ?? "");
      }
      spec.channels[channel].config = next;
    }
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    return this.renderArtifacts();
  }
  getServiceConfig(service) {
    const spec = this.getSpec();
    if (!spec.services[service]) throw new Error(`unknown_service_${service}`);
    return { ...spec.services[service].config };
  }
  setServiceConfig(service, values) {
    const spec = this.getSpec();
    if (!spec.services[service]) throw new Error(`unknown_service_${service}`);
    const next = {};
    for (const [key, value] of Object.entries(values)) {
      if (!key.trim()) continue;
      next[key] = sanitizeEnvScalar(value ?? "");
    }
    spec.services[service].enabled = true;
    spec.services[service].config = next;
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    return this.renderArtifacts();
  }
  listStackCatalogItems(snippets = []) {
    const spec = this.getSpec();
    const items = [];
    const installedTemplates = /* @__PURE__ */ new Set();
    for (const [name, channel] of Object.entries(spec.channels)) {
      const templateName = channel.template ?? (isBuiltInChannel(name) ? name : name);
      if (channel.enabled) installedTemplates.add(`channel:${templateName}`);
      const builtIn = BUILTIN_CHANNELS[templateName];
      const envDefs = builtIn ? builtIn.env : Object.keys(channel.config).map((key) => ({ name: key, required: false }));
      items.push({
        id: `installed:channel:${name}`,
        type: "channel",
        name,
        displayName: builtIn?.name ?? channel.name ?? name,
        description: builtIn?.description ?? channel.description ?? "",
        tags: ["channel", builtIn ? "built-in" : "custom"],
        enabled: channel.enabled,
        installed: true,
        entryKind: "installed",
        templateName,
        supportsMultipleInstances: channel.supportsMultipleInstances === true,
        exposure: channel.exposure,
        config: { ...channel.config },
        fields: envDefs.map((field) => ({ key: field.name, required: field.required, description: field.description, defaultValue: field.default })),
        image: channel.image,
        containerPort: channel.containerPort,
        rewritePath: channel.rewritePath,
        sharedSecretEnv: channel.sharedSecretEnv,
        volumes: channel.volumes
      });
    }
    for (const [name, service] of Object.entries(spec.services)) {
      const templateName = service.template ?? name;
      if (service.enabled) installedTemplates.add(`service:${templateName}`);
      items.push({
        id: `installed:service:${name}`,
        type: "service",
        name,
        displayName: service.name ?? name,
        description: service.description ?? "",
        tags: ["service", "custom"],
        enabled: service.enabled,
        installed: true,
        entryKind: "installed",
        templateName,
        supportsMultipleInstances: service.supportsMultipleInstances === true,
        config: { ...service.config },
        fields: Object.keys(service.config).map((key) => ({ key, required: false })),
        image: service.image,
        containerPort: service.containerPort,
        volumes: service.volumes,
        dependsOn: service.dependsOn
      });
    }
    for (const [name, def] of Object.entries(BUILTIN_CHANNELS)) {
      const templateKey = `channel:${name}`;
      if (installedTemplates.has(templateKey)) continue;
      items.push({
        id: `template:channel:${name}`,
        type: "channel",
        name,
        displayName: def.name,
        description: def.description ?? "",
        tags: ["channel", "template", "built-in"],
        enabled: false,
        installed: false,
        entryKind: "template",
        templateName: name,
        supportsMultipleInstances: false,
        exposure: "lan",
        config: Object.fromEntries(def.env.map((field) => [field.name, field.default ?? ""])),
        fields: def.env.map((field) => ({ key: field.name, required: field.required, description: field.description, defaultValue: field.default })),
        containerPort: def.containerPort,
        rewritePath: def.rewritePath,
        sharedSecretEnv: def.sharedSecretEnv
      });
    }
    for (const snippet of snippets) {
      if (snippet.kind !== "channel" && snippet.kind !== "service") continue;
      const type = snippet.kind;
      const templateName = sanitizeEnvScalar(snippet.name);
      if (!templateName) continue;
      const templateKey = `${type}:${templateName}`;
      const supportsMultipleInstances = snippet.supportsMultipleInstances === true;
      if (installedTemplates.has(templateKey) && !supportsMultipleInstances) continue;
      items.push({
        id: `template:${type}:${templateName}`,
        type,
        name: templateName,
        displayName: snippet.name,
        description: snippet.description ?? "",
        tags: [type, "template", snippet.trust, snippet.sourceName],
        enabled: false,
        installed: false,
        entryKind: "template",
        templateName,
        supportsMultipleInstances,
        exposure: type === "channel" ? "lan" : void 0,
        config: Object.fromEntries(snippet.env.map((field) => [field.name, field.default ?? ""])),
        fields: snippet.env.map((field) => ({ key: field.name, required: field.required, description: field.description, defaultValue: field.default })),
        image: snippet.image,
        containerPort: snippet.containerPort,
        rewritePath: snippet.rewritePath,
        sharedSecretEnv: snippet.sharedSecretEnv,
        volumes: snippet.volumes,
        dependsOn: snippet.dependsOn
      });
    }
    return items.sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      if (a.entryKind !== b.entryKind) return a.entryKind.localeCompare(b.entryKind);
      return a.displayName.localeCompare(b.displayName);
    });
  }
  mutateStackCatalogItem(input) {
    const action = input.action;
    const type = input.type;
    const name = sanitizeEnvScalar(input.name);
    if (!name) throw new Error("invalid_catalog_item_name");
    const spec = this.getSpec();
    if (action === "add_instance") {
      const templateName = sanitizeEnvScalar(input.templateName ?? name);
      if (!templateName) throw new Error("invalid_catalog_template_name");
      const supportsMultipleInstances = input.supportsMultipleInstances === true;
      const fields = Array.isArray(input.fields) ? input.fields : [];
      const defaults = Object.fromEntries(fields.filter((field) => typeof field === "object" && field !== null && typeof field.key === "string").map((field) => {
        const value = field;
        const fallback = typeof value.defaultValue === "string" ? sanitizeEnvScalar(value.defaultValue) : "";
        return [sanitizeEnvScalar(value.key), fallback];
      }).filter(([key]) => key.length > 0));
      const displayName = sanitizeEnvScalar(input.displayName) || templateName;
      const description = sanitizeEnvScalar(input.description);
      const image = sanitizeEnvScalar(input.image);
      const containerPort = typeof input.containerPort === "number" && Number.isInteger(input.containerPort) ? input.containerPort : void 0;
      const volumes = Array.isArray(input.volumes) ? input.volumes.filter((v) => typeof v === "string").map((v) => sanitizeEnvScalar(v)).filter((v) => v.length > 0) : void 0;
      const dependsOn = Array.isArray(input.dependsOn) ? input.dependsOn.filter((v) => typeof v === "string").map((v) => sanitizeEnvScalar(v)).filter((v) => v.length > 0) : void 0;
      let instanceName = "";
      if (type === "channel") {
        const used = new Set(Object.keys(spec.channels));
        const baseName = composeServiceName(templateName || name);
        if (!baseName) throw new Error("invalid_catalog_channel_base_name");
        if (!supportsMultipleInstances && spec.channels[baseName]) {
          throw new Error(`multiple_instances_not_supported_for_channel_template_${templateName}`);
        }
        instanceName = nextInstanceName(baseName, used);
        const channel = {
          enabled: true,
          exposure: "lan",
          template: templateName,
          supportsMultipleInstances,
          name: displayName,
          description: description || void 0,
          image: image || void 0,
          containerPort,
          rewritePath: typeof input.rewritePath === "string" ? sanitizeEnvScalar(input.rewritePath) : void 0,
          sharedSecretEnv: typeof input.sharedSecretEnv === "string" ? sanitizeEnvScalar(input.sharedSecretEnv) : void 0,
          volumes,
          config: defaults
        };
        spec.channels[instanceName] = channel;
      } else {
        const used = new Set(Object.keys(spec.services));
        const baseName = composeServiceName(templateName || name);
        if (!baseName) throw new Error("invalid_catalog_service_base_name");
        if (!supportsMultipleInstances && spec.services[baseName]) {
          throw new Error(`multiple_instances_not_supported_for_service_template_${templateName}`);
        }
        instanceName = nextInstanceName(baseName, used);
        if (!image) throw new Error("missing_service_image_for_catalog_instance");
        if (!containerPort) throw new Error("missing_service_port_for_catalog_instance");
        spec.services[instanceName] = {
          enabled: true,
          template: templateName,
          supportsMultipleInstances,
          name: displayName,
          description: description || void 0,
          image,
          containerPort,
          volumes,
          dependsOn,
          config: defaults
        };
      }
      const validated2 = parseStackSpec(spec);
      this.writeStackSpecAtomically(stringifyStackSpec(validated2));
      this.cachedSpec = validated2;
      this.renderArtifacts();
      const updated2 = this.listStackCatalogItems().find(
        (item) => item.type === type && item.entryKind === "installed" && item.name === instanceName
      );
      if (!updated2) throw new Error(`catalog_item_not_found_after_add_instance_${type}_${templateName}`);
      return updated2;
    }
    if (type === "channel") {
      const channel = spec.channels[name];
      if (!channel) throw new Error(`unknown_channel_${name}`);
      if (action === "install") {
        channel.enabled = true;
      } else if (action === "uninstall") {
        channel.enabled = false;
      } else {
        if (input.exposure === "host" || input.exposure === "lan" || input.exposure === "public") {
          channel.exposure = input.exposure;
        }
        if (input.config && typeof input.config === "object" && !Array.isArray(input.config)) {
          const next = {};
          const current = channel.config;
          if (isBuiltInChannel(name)) {
            for (const key of Object.keys(current)) {
              const value = input.config[key];
              next[key] = typeof value === "string" ? sanitizeEnvScalar(value) : "";
            }
          } else {
            for (const [key, value] of Object.entries(input.config)) {
              if (!key.trim() || typeof value !== "string") continue;
              next[key] = sanitizeEnvScalar(value);
            }
          }
          channel.config = next;
        }
        channel.enabled = true;
      }
    } else {
      const service = spec.services[name];
      if (!service) throw new Error(`unknown_service_${name}`);
      if (action === "install") {
        service.enabled = true;
      } else if (action === "uninstall") {
        service.enabled = false;
      } else {
        if (input.config && typeof input.config === "object" && !Array.isArray(input.config)) {
          const next = {};
          for (const [key, value] of Object.entries(input.config)) {
            if (!key.trim() || typeof value !== "string") continue;
            next[key] = sanitizeEnvScalar(value);
          }
          service.config = next;
        }
        service.enabled = true;
      }
    }
    const validated = parseStackSpec(spec);
    this.writeStackSpecAtomically(stringifyStackSpec(validated));
    this.cachedSpec = validated;
    this.renderArtifacts();
    const updated = this.listStackCatalogItems().find((item) => item.type === type && item.name === name && item.entryKind === "installed");
    if (!updated) throw new Error(`catalog_item_not_found_after_mutation_${type}_${name}`);
    return updated;
  }
  setAccessScope(scope) {
    const spec = this.getSpec();
    spec.accessScope = scope;
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    return this.renderArtifacts();
  }
  renderPreview() {
    return generateStackArtifacts(this.getSpec(), this.readSecretsEnv());
  }
  renderArtifacts(precomputed) {
    const generated = precomputed ?? this.renderPreview();
    const changedArtifacts = [];
    const write = (path, content) => this.writeArtifact(path, content, changedArtifacts);
    write(this.paths.caddyJsonPath, generated.caddyJson);
    write(this.paths.composeFilePath, generated.composeFile);
    write(this.paths.systemEnvPath, generated.systemEnv);
    write(this.paths.gatewayEnvPath, generated.gatewayEnv);
    write(this.paths.openmemoryEnvPath, generated.openmemoryEnv);
    write(this.paths.postgresEnvPath, generated.postgresEnv);
    write(this.paths.qdrantEnvPath, generated.qdrantEnv);
    write(this.paths.assistantEnvPath, generated.assistantEnv);
    for (const [serviceName, content] of Object.entries(generated.channelEnvs)) {
      write(join(this.paths.stateRootPath, serviceName, ".env"), content);
    }
    for (const [serviceName, content] of Object.entries(generated.serviceEnvs)) {
      write(join(this.paths.stateRootPath, serviceName, ".env"), content);
    }
    const secrets = this.readSecretsEnv();
    const runtimeEnvEntries = {
      OPENPALM_STATE_HOME: this.paths.stateRootPath,
      OPENPALM_DATA_HOME: this.paths.dataRootPath,
      OPENPALM_CONFIG_HOME: this.paths.configRootPath,
      POSTGRES_PASSWORD: secrets["POSTGRES_PASSWORD"]
    };
    if (this.runtimeEnvCache === null) {
      this.runtimeEnvCache = existsSync(this.paths.runtimeEnvPath) ? readFileSync(this.paths.runtimeEnvPath, "utf8") : "";
    }
    const existingRuntime = this.runtimeEnvCache;
    const updatedRuntime = updateRuntimeEnvContent(existingRuntime, runtimeEnvEntries);
    mkdirSync(dirname(this.paths.runtimeEnvPath), { recursive: true });
    writeFileSync(this.paths.runtimeEnvPath, updatedRuntime, "utf8");
    this.runtimeEnvCache = updatedRuntime;
    const renderReportPath = this.paths.renderReportPath ?? join(this.paths.stateRootPath, "render-report.json");
    const renderReport = {
      ...generated.renderReport,
      changedArtifacts,
      applySafe: generated.renderReport.missingSecretReferences.length === 0
    };
    mkdirSync(dirname(renderReportPath), { recursive: true });
    writeFileSync(renderReportPath, `${JSON.stringify(renderReport, null, 2)}
`, "utf8");
    return { ...generated, renderReport };
  }
  validateReferencedSecrets(specOverride) {
    const spec = specOverride ?? this.getSpec();
    const availableSecrets = this.readSecretsEnv();
    const errors = [];
    for (const [channel, cfg] of Object.entries(spec.channels)) {
      if (!cfg.enabled) continue;
      for (const [key, value] of Object.entries(cfg.config)) {
        const ref = parseSecretReference(value);
        if (!ref) continue;
        if (!availableSecrets[ref]) errors.push(`missing_secret_reference_${channel}_${key}_${ref}`);
      }
    }
    for (const [service, cfg] of Object.entries(spec.services)) {
      if (!cfg.enabled) continue;
      for (const [key, value] of Object.entries(cfg.config)) {
        const ref = parseSecretReference(value);
        if (!ref) continue;
        if (!availableSecrets[ref]) errors.push(`missing_secret_reference_${service}_${key}_${ref}`);
      }
    }
    return errors;
  }
  listSecretManagerState() {
    const spec = this.getSpec();
    const secretValues = this.readSecretsEnv();
    const usedBy = /* @__PURE__ */ new Map();
    for (const item of CoreSecretRequirements) {
      const list = usedBy.get(item.key) ?? [];
      list.push(`core:${item.service}`);
      usedBy.set(item.key, list);
    }
    for (const [channel, cfg] of Object.entries(spec.channels)) {
      for (const [key, value] of Object.entries(cfg.config)) {
        const ref = parseSecretReference(value);
        if (!ref) continue;
        const list = usedBy.get(ref) ?? [];
        list.push(`channel:${channel}:${key}`);
        usedBy.set(ref, list);
      }
    }
    for (const [service, cfg] of Object.entries(spec.services)) {
      for (const [key, value] of Object.entries(cfg.config)) {
        const ref = parseSecretReference(value);
        if (!ref) continue;
        const list = usedBy.get(ref) ?? [];
        list.push(`service:${service}:${key}`);
        usedBy.set(ref, list);
      }
    }
    const uniqueNames = Array.from(/* @__PURE__ */ new Set([
      ...Object.keys(secretValues),
      ...Array.from(usedBy.keys()),
      ...CoreSecretRequirements.map((item) => item.key)
    ])).sort();
    return {
      available: uniqueNames,
      requiredCore: CoreSecretRequirements,
      secrets: uniqueNames.map((name) => ({
        name,
        configured: Boolean(secretValues[name]),
        usedBy: usedBy.get(name) ?? []
      }))
    };
  }
  upsertSecret(nameRaw, valueRaw) {
    const name = sanitizeEnvScalar(nameRaw).toUpperCase();
    if (!this.isValidSecretName(name)) throw new Error("invalid_secret_name");
    const value = sanitizeEnvScalar(valueRaw);
    this.updateSecretsEnv({ [name]: value || void 0 });
    this.renderArtifacts();
    return name;
  }
  deleteSecret(nameRaw) {
    const name = sanitizeEnvScalar(nameRaw).toUpperCase();
    if (!this.isValidSecretName(name)) throw new Error("invalid_secret_name");
    const usedByCore = CoreSecretRequirements.some((item) => item.key === name);
    const usedByReferences = this.listSecretManagerState().secrets.some((item) => item.name === name && item.usedBy.length > 0);
    if (usedByCore || usedByReferences) throw new Error("secret_in_use");
    this.updateSecretsEnv({ [name]: void 0 });
    return name;
  }
  listAutomations() {
    return this.getSpec().automations;
  }
  getAutomation(idRaw) {
    const id = sanitizeEnvScalar(idRaw);
    if (!id) return void 0;
    return this.getSpec().automations.find((automation) => automation.id === id);
  }
  upsertAutomation(input) {
    const id = sanitizeEnvScalar(input.id);
    const name = sanitizeEnvScalar(input.name);
    const schedule = sanitizeEnvScalar(input.schedule);
    const scriptRaw = typeof input.script === "string" ? input.script : "";
    const script = scriptRaw.trim();
    if (!id) throw new Error("invalid_automation_id");
    if (!name) throw new Error("invalid_automation_name");
    if (!schedule) throw new Error("invalid_automation_schedule");
    const cronError = validateCron(schedule);
    if (cronError) throw new Error("invalid_cron_schedule");
    if (!script) throw new Error("invalid_automation_script");
    if (typeof input.enabled !== "boolean") throw new Error("invalid_automation_enabled");
    const spec = this.getSpec();
    const automation = { id, name, schedule, enabled: input.enabled, script };
    if (typeof input.description === "string" && input.description.trim()) automation.description = input.description.trim();
    if (input.core === true) automation.core = true;
    const index = spec.automations.findIndex((item) => item.id === id);
    if (index >= 0) spec.automations[index] = automation;
    else spec.automations.push(automation);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    return automation;
  }
  deleteAutomation(idRaw) {
    const id = sanitizeEnvScalar(idRaw);
    if (!id) throw new Error("invalid_automation_id");
    const spec = this.getSpec();
    const existing = spec.automations.find((automation) => automation.id === id);
    if (!existing) return false;
    if (existing.core) throw new Error("cannot_delete_core_automation");
    spec.automations = spec.automations.filter((automation) => automation.id !== id);
    this.writeStackSpecAtomically(stringifyStackSpec(spec));
    this.cachedSpec = spec;
    return true;
  }
  /** Returns all channel names (built-in + custom) from the spec. */
  listChannelNames() {
    return Object.keys(this.getSpec().channels);
  }
  /** Returns enabled channel service names (e.g., "channel-chat", "channel-my-custom"). */
  enabledChannelServiceNames() {
    const spec = this.getSpec();
    return Object.keys(spec.channels).filter((name) => spec.channels[name].enabled).map((name) => `channel-${composeServiceName(name)}`);
  }
  /** Returns all service names from the spec. */
  listServiceNames() {
    return Object.keys(this.getSpec().services);
  }
  /** Returns enabled service names (e.g., "service-n8n"). */
  enabledServiceNames() {
    const spec = this.getSpec();
    return Object.keys(spec.services).filter((name) => spec.services[name].enabled).map((name) => `service-${composeServiceName(name)}`);
  }
  writeArtifact(path, content, changedList) {
    let current = this.artifactContentCache.get(path);
    if (current === void 0) {
      current = existsSync(path) ? readFileSync(path, "utf8") : "";
      this.artifactContentCache.set(path, current);
    }
    if (current !== content) changedList.push(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    this.artifactContentCache.set(path, content);
  }
  writeStackSpecAtomically(content) {
    const tempPath = `${this.paths.stackSpecPath}.${randomUUID()}.tmp`;
    mkdirSync(dirname(this.paths.stackSpecPath), { recursive: true });
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, this.paths.stackSpecPath);
  }
  readSecretsEnv() {
    const secretsMtime = existsSync(this.paths.secretsEnvPath) ? statSync(this.paths.secretsEnvPath).mtimeMs : -1;
    const dataEnvPath = this.paths.dataEnvPath;
    const dataMtime = dataEnvPath && existsSync(dataEnvPath) ? statSync(dataEnvPath).mtimeMs : -1;
    if (this.cachedSecrets && this.secretsFileMtimeMs === secretsMtime && this.dataEnvFileMtimeMs === dataMtime) {
      return this.cachedSecrets;
    }
    const secrets = existsSync(this.paths.secretsEnvPath) ? parseRuntimeEnvContent(readFileSync(this.paths.secretsEnvPath, "utf8")) : {};
    let merged = secrets;
    if (dataEnvPath && existsSync(dataEnvPath)) {
      const dataEnv = parseRuntimeEnvContent(readFileSync(dataEnvPath, "utf8"));
      const profileEnv = pickEnv(dataEnv, ["OPENPALM_PROFILE_NAME", "OPENPALM_PROFILE_EMAIL"]);
      merged = { ...secrets, ...profileEnv };
    }
    this.secretsFileMtimeMs = secretsMtime;
    this.dataEnvFileMtimeMs = dataMtime;
    this.cachedSecrets = merged;
    return merged;
  }
  /** Returns the compose interpolation entries that must be present in runtimeEnvPath. */
  getRuntimeEnvEntries() {
    const secrets = this.readSecretsEnv();
    return {
      OPENPALM_STATE_HOME: this.paths.stateRootPath,
      OPENPALM_DATA_HOME: this.paths.dataRootPath,
      OPENPALM_CONFIG_HOME: this.paths.configRootPath,
      POSTGRES_PASSWORD: secrets["POSTGRES_PASSWORD"]
    };
  }
  updateSecretsEnv(entries) {
    const current = existsSync(this.paths.secretsEnvPath) ? readFileSync(this.paths.secretsEnvPath, "utf8") : "";
    const next = updateRuntimeEnvContent(current, entries);
    writeFileSync(this.paths.secretsEnvPath, next, "utf8");
    this.cachedSecrets = null;
    this.secretsFileMtimeMs = null;
  }
  isValidSecretName(name) {
    return /^[A-Z][A-Z0-9_]*$/.test(name);
  }
}
export {
  CoreSecretRequirements,
  StackManager
};
