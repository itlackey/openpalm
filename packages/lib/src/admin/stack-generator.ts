import { parseSecretReference, isBuiltInChannel, BuiltInChannelPorts, getBuiltInChannelDef } from "./stack-spec.ts";
import type { BuiltInChannelName, StackChannelConfig, StackServiceConfig, StackSpec } from "./stack-spec.ts";
import { renderCaddyComposeService, renderOpenMemoryComposeService, renderOpenMemoryUiComposeService, renderPostgresComposeService, renderQdrantComposeService } from "./core-services.ts";

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
  caddyJson: string;
  composeFile: string;
  systemEnv: string;
  gatewayEnv: string;
  openmemoryEnv: string;
  postgresEnv: string;
  qdrantEnv: string;
  assistantEnv: string;
  channelEnvs: Record<string, string>;
  serviceEnvs: Record<string, string>;
  renderReport: {
    applySafe: boolean;
    warnings: string[];
    missingSecretReferences: string[];
    changedArtifacts: string[];
  };
};

// ── Caddy JSON API config types ──────────────────────────────────────

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
  apps: {
    http: {
      servers: Record<string, CaddyServer>;
    };
    tls?: Record<string, unknown>;
  };
};

// ── Caddy JSON helpers ───────────────────────────────────────────────

function renderLanRanges(scope: StackSpec["accessScope"]): string[] {
  if (scope === "host") return ["127.0.0.0/8", "::1"];
  return ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "::1", "fd00::/8"];
}

function caddyGuardHandler(): Record<string, unknown> {
  return {
    handler: "static_response",
    status_code: "403",
    headers: { Connection: ["close"] },
  };
}

function caddyGuardMatcher(ranges: string[], negate: boolean): Record<string, unknown> {
  if (negate) {
    return { not: [{ remote_ip: { ranges } }] };
  }
  return { remote_ip: { ranges } };
}

function caddyHostRoute(hostname: string, upstream: string, guardRanges: string[]): CaddyRoute {
  return {
    match: [{ host: [hostname] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            match: [caddyGuardMatcher(guardRanges, true)],
            handle: [caddyGuardHandler()],
            terminal: true,
          },
          {
            handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }],
          },
        ],
      },
    ],
    terminal: true,
  };
}

function caddyAdminSubroute(guardRanges: string[]): CaddyRoute {
  return {
    match: [{ path: ["/api*", "/services/opencode*", "/services/openmemory*"] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          // Guard: block non-LAN
          {
            match: [caddyGuardMatcher(guardRanges, true)],
            handle: [caddyGuardHandler()],
            terminal: true,
          },
          // /api* → strip API prefix and proxy to admin:8100
          {
            match: [{ path: ["/api*"] }],
            handle: [
              { handler: "rewrite", strip_path_prefix: "/api" },
              { handler: "reverse_proxy", upstreams: [{ dial: "admin:8100" }] },
            ],
            terminal: true,
          },
          // /services/opencode* → strip prefix + proxy to assistant:4096
          {
            match: [{ path: ["/services/opencode*"] }],
            handle: [
              { handler: "rewrite", strip_path_prefix: "/services/opencode" },
              { handler: "reverse_proxy", upstreams: [{ dial: "assistant:4096" }] },
            ],
            terminal: true,
          },
          // /services/openmemory* → strip prefix + proxy to openmemory-ui:3000
          {
            match: [{ path: ["/services/openmemory*"] }],
            handle: [
              { handler: "rewrite", strip_path_prefix: "/services/openmemory" },
              { handler: "reverse_proxy", upstreams: [{ dial: "openmemory-ui:3000" }] },
            ],
            terminal: true,
          },
        ],
      },
    ],
    terminal: true,
  };
}

function caddyChannelRoute(name: string, cfg: StackChannelConfig, spec: StackSpec): CaddyRoute | null {
  if (!cfg.enabled) return null;
  if (cfg.domains && cfg.domains.length > 0) return null;

  const containerPort = resolveChannelPort(name, cfg);
  const svcName = `channel-${composeServiceName(name)}`;
  const guardRanges = renderLanRanges(spec.accessScope);
  const subrouteHandlers: CaddyRoute[] = [];

  // Add IP guard for non-public channels
  if (cfg.exposure === "lan" || cfg.exposure === "host") {
    const ranges = cfg.exposure === "host" ? ["127.0.0.0/8", "::1"] : guardRanges;
    subrouteHandlers.push({
      match: [caddyGuardMatcher(ranges, true)],
      handle: [caddyGuardHandler()],
      terminal: true,
    });
  }

  const rewritePath = cfg.rewritePath ?? (isBuiltInChannel(name) ? getBuiltInChannelDef(name).rewritePath : undefined);
  if (rewritePath) {
    subrouteHandlers.push({
      handle: [
        { handler: "rewrite", uri: rewritePath },
        { handler: "reverse_proxy", upstreams: [{ dial: `${svcName}:${containerPort}` }] },
      ],
    });
  } else {
    subrouteHandlers.push({
      handle: [
        { handler: "rewrite", strip_path_prefix: `/channels/${name}` },
        { handler: "reverse_proxy", upstreams: [{ dial: `${svcName}:${containerPort}` }] },
      ],
    });
  }

  return {
    match: [{ path: [`/channels/${name}*`] }],
    handle: [{ handler: "subroute", routes: subrouteHandlers }],
    terminal: true,
  };
}

function caddyDomainRoute(domain: string, svcName: string, port: number, cfg: StackChannelConfig, spec: StackSpec): CaddyRoute[] {
  const routes: CaddyRoute[] = [];
  const guardRanges = renderLanRanges(spec.accessScope);

  const subrouteHandlers: CaddyRoute[] = [];

  // Add IP guard for non-public channels
  if (cfg.exposure === "lan" || cfg.exposure === "host") {
    const ranges = cfg.exposure === "host" ? ["127.0.0.0/8", "::1"] : guardRanges;
    subrouteHandlers.push({
      match: [caddyGuardMatcher(ranges, true)],
      handle: [caddyGuardHandler()],
      terminal: true,
    });
  }

  const paths = cfg.pathPrefixes?.length ? cfg.pathPrefixes : ["/"];
  for (const p of paths) {
    const prefix = p.startsWith("/") ? p : `/${p}`;
    if (prefix === "/" || prefix === "/*") {
      subrouteHandlers.push({
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `${svcName}:${port}` }] }],
      });
    } else {
      subrouteHandlers.push({
        match: [{ path: [`${prefix}*`] }],
        handle: [
          { handler: "rewrite", strip_path_prefix: prefix },
          { handler: "reverse_proxy", upstreams: [{ dial: `${svcName}:${port}` }] },
        ],
        terminal: true,
      });
    }
  }

  return [{
    match: [{ host: cfg.domains! }],
    handle: [{ handler: "subroute", routes: subrouteHandlers }],
    terminal: true,
  }];
}

function renderCaddyJsonConfig(spec: StackSpec): CaddyJsonConfig {
  const guardRanges = renderLanRanges(spec.accessScope);
  const mainRoutes: CaddyRoute[] = [];
  const domainRoutes: CaddyRoute[] = [];

  // Hostname route for local entrypoint without DNS setup
  mainRoutes.push(caddyHostRoute("localhost", "admin:8100", guardRanges));

  // Admin subroute
  mainRoutes.push(caddyAdminSubroute(guardRanges));

  // Channel routes (path-based and domain-based)
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

  // Default catch-all → admin
  // The SvelteKit admin UI is served at "/" through this catch-all route.
  mainRoutes.push({
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            match: [caddyGuardMatcher(guardRanges, true)],
            handle: [caddyGuardHandler()],
            terminal: true,
          },
          {
            handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "admin:8100" }] }],
          },
        ],
      },
    ],
  });

  const servers: Record<string, CaddyServer> = {
    main: {
      listen: [":80"],
      routes: mainRoutes,
    },
  };

  // Domain routes go into an HTTPS server if any domains are configured
  if (domainRoutes.length > 0) {
    servers.tls_domains = {
      listen: [":443"],
      routes: domainRoutes,
    };
  }

  const config: CaddyJsonConfig = {
    admin: { disabled: true },
    apps: {
      http: { servers },
    },
  };

  // Add TLS config if email is set
  if (spec.caddy?.email) {
    config.apps.tls = {
      automation: {
        policies: [{
          issuers: [{
            module: "acme",
            email: spec.caddy.email,
          }],
        }],
      },
    };
  }

  return config;
}

// ── Env helpers ──────────────────────────────────────────────────────

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

// ── Compose service renderers ────────────────────────────────────────

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
    "    networks: [channel_net]",
    "    depends_on:",
    "      gateway:",
    "        condition: service_healthy",
    "    healthcheck:",
    `      test: ["CMD-SHELL", "curl -sf http://localhost:${containerPort}/health || exit 1"]`,
    "      interval: 10s",
    "      timeout: 5s",
    "      retries: 3",
  ].join("\n");
}

function renderAssistantComposeService(): string {
  return [
    "  assistant:",
    "    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/assistant:${OPENPALM_IMAGE_TAG:-latest}",
    "    restart: unless-stopped",
    "    env_file:",
    "      - ${OPENPALM_STATE_HOME}/assistant/.env",
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
    "      - ${OPENPALM_WORK_HOME:-${HOME}/openpalm}:/work",
    "    working_dir: /work",
    "    user: \"${OPENPALM_UID:-1000}:${OPENPALM_GID:-1000}\"",
    "    networks: [assistant_net]",
    "    depends_on:",
    "      openmemory:",
    "        condition: service_healthy",
    "    healthcheck:",
    "      test: [\"CMD\", \"curl\", \"-fs\", \"http://localhost:4096/\"]",
    "      interval: 30s",
    "      timeout: 10s",
    "      retries: 5",
    "      start_period: 30s",
  ].join("\n");
}

function renderGatewayComposeService(): string {
  return [
    "  gateway:",
    "    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/gateway:${OPENPALM_IMAGE_TAG:-latest}",
    "    restart: unless-stopped",
    "    env_file:",
    "      - ${OPENPALM_STATE_HOME}/system.env",
    "      - ${OPENPALM_STATE_HOME}/gateway/.env",
    "    environment:",
    "      - PORT=8080",
    "      - OPENCODE_CORE_BASE_URL=http://assistant:4096",
    "      - OPENCODE_TIMEOUT_MS=${OPENCODE_TIMEOUT_MS:-15000}",
    "    volumes:",
    "      - ${OPENPALM_STATE_HOME}/gateway:/app/data",
    "      - ${OPENPALM_STATE_HOME}:/state:ro",
    "    user: \"${OPENPALM_UID:-1000}:${OPENPALM_GID:-1000}\"",
    "    networks: [channel_net, assistant_net]",
    "    depends_on:",
    "      assistant:",
    "        condition: service_healthy",
    "    healthcheck:",
    "      test: [\"CMD\", \"curl\", \"-fs\", \"http://localhost:8080/health\"]",
    "      interval: 30s",
    "      timeout: 5s",
    "      retries: 3",
    "      start_period: 10s",
  ].join("\n");
}

function renderAdminComposeService(): string {
  return [
    "  admin:",
    "    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:${OPENPALM_IMAGE_TAG:-latest}",
    "    restart: unless-stopped",
    "    env_file:",
    "      - ${OPENPALM_STATE_HOME}/system.env",
    "    environment:",
    "      - PORT=8100",
    "      - ADMIN_TOKEN=${ADMIN_TOKEN:?ADMIN_TOKEN must be set}",
    "      - GATEWAY_URL=http://gateway:8080",
    "      - OPENCODE_CORE_URL=http://assistant:4096",
    "      - OPENPALM_COMPOSE_BIN=${OPENPALM_COMPOSE_BIN:-docker}",
    "      - OPENPALM_COMPOSE_SUBCOMMAND=${OPENPALM_COMPOSE_SUBCOMMAND:-compose}",
    "      - OPENPALM_CONTAINER_SOCKET_URI=${OPENPALM_CONTAINER_SOCKET_URI:-unix:///var/run/docker.sock}",
    "      - COMPOSE_PROJECT_PATH=/state",
    "      - OPENPALM_COMPOSE_FILE=docker-compose.yml",
    "    volumes:",
    "      - ${OPENPALM_DATA_HOME}:/data",
    "      - ${OPENPALM_CONFIG_HOME}:/config",
    "      - ${OPENPALM_STATE_HOME}:/state",
    "      - ${OPENPALM_WORK_HOME:-${HOME}/openpalm}:/work",
    "      - ${OPENPALM_CONTAINER_SOCKET_PATH:-/var/run/docker.sock}:${OPENPALM_CONTAINER_SOCKET_IN_CONTAINER:-/var/run/docker.sock}",
    "    networks: [assistant_net]",
    "    healthcheck:",
    "      test: [\"CMD\", \"curl\", \"-fs\", \"http://localhost:8100/health\"]",
    "      interval: 30s",
    "      timeout: 5s",
    "      retries: 3",
    "      start_period: 10s",
  ].join("\n");
}

function renderServiceComposeService(name: string, config: StackServiceConfig): string {
  const svcName = `service-${composeServiceName(name)}`;
  const lines = [
    `  ${svcName}:`,
    `    image: ${config.image}`,
    "    restart: unless-stopped",
    "    env_file:",
    `      - \${OPENPALM_STATE_HOME}/${svcName}/.env`,
    "    environment:",
    `      - PORT=${config.containerPort}`,
  ];

  if (config.volumes && config.volumes.length > 0) {
    lines.push("    volumes:");
    for (const v of config.volumes) {
      lines.push(`      - ${v}`);
    }
  }

  lines.push("    networks: [assistant_net]");

  if (config.dependsOn && config.dependsOn.length > 0) {
    lines.push(`    depends_on: [${config.dependsOn.join(", ")}]`);
  }

  return lines.join("\n");
}

function renderFullComposeFile(spec: StackSpec): string {
  const coreBlocks = [
    renderCaddyComposeService(),
    renderPostgresComposeService(),
    renderQdrantComposeService(),
    renderOpenMemoryComposeService(),
    renderOpenMemoryUiComposeService(),
    renderAssistantComposeService(),
    renderGatewayComposeService(),
    renderAdminComposeService(),
  ];

  const channelBlocks = Object.keys(spec.channels)
    .filter((name) => spec.channels[name].enabled)
    .map((name) => renderChannelComposeService(name, spec.channels[name]));

  const serviceBlocks = Object.keys(spec.services)
    .filter((name) => spec.services[name].enabled)
    .map((name) => renderServiceComposeService(name, spec.services[name]));

  const allBlocks = [...coreBlocks, ...channelBlocks, ...serviceBlocks];

  return `services:\n${allBlocks.join("\n\n")}\n\nnetworks:\n  channel_net:\n  assistant_net:\n`;
}

// ── Main generator ───────────────────────────────────────────────────

export function generateStackArtifacts(spec: StackSpec, secrets: Record<string, string>): GeneratedStackArtifacts {
  const caddyConfig = renderCaddyJsonConfig(spec);
  const caddyJson = JSON.stringify(caddyConfig, null, 2) + "\n";

  const channelEnvs: Record<string, string> = {};
  for (const [name, cfg] of Object.entries(spec.channels)) {
    if (!cfg.enabled) continue;
    const svcName = `channel-${composeServiceName(name)}`;
    channelEnvs[svcName] = envWithHeader(
      `# Generated channel env (${name})`,
      resolveChannelConfig(name, cfg, secrets),
    );
  }

  const enabledChannels = Object.keys(spec.channels)
    .filter((name) => spec.channels[name].enabled)
    .map((name) => `channel-${composeServiceName(name)}`)
    .join(",");

  const systemEnv = envWithHeader("# Generated system env — do not edit; regenerated on every stack apply", {
    OPENPALM_ACCESS_SCOPE: spec.accessScope,
    OPENPALM_ENABLED_CHANNELS: enabledChannels,
  });

  const gatewayEnv = envWithHeader("# Generated gateway env", {
    ...pickEnvByPrefixes(secrets, ["OPENPALM_GATEWAY_", "GATEWAY_", "OPENPALM_SMALL_MODEL_API_KEY", "ANTHROPIC_API_KEY"]),
  });

  const serviceEnvs: Record<string, string> = {};
  for (const [name, cfg] of Object.entries(spec.services)) {
    if (!cfg.enabled) continue;
    const svcName = `service-${composeServiceName(name)}`;
    const resolved: Record<string, string> = {};
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
    }),
    channelEnvs,
    serviceEnvs,
    renderReport: {
      applySafe: true,
      warnings: [],
      missingSecretReferences: [],
      changedArtifacts: [],
    },
  };
}
