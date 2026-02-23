import { describe, expect, it } from "bun:test";
import { generateStackArtifacts } from "./stack-generator.ts";
import { createDefaultStackSpec } from "./stack-spec.ts";

describe("stack generator", () => {
  it("renders all core and enabled channel services in compose output", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    expect(caddyConfig.admin.disabled).toBe(true);
    expect(caddyConfig.apps.http.servers.main.listen).toContain(":80");
    expect(out.composeFile).toContain("caddy:");
    expect(out.composeFile).toContain("/caddy.json:/etc/caddy/caddy.json:ro");
    expect(out.composeFile).toContain("assistant:");
    expect(out.composeFile).toContain("${OPENPALM_DATA_HOME}/assistant:/home/opencode");
    expect(out.composeFile).toContain("OPENPALM_ADMIN_API_URL=http://admin:8100");
    expect(out.composeFile).toContain("OPENPALM_ADMIN_TOKEN=${ADMIN_TOKEN:?ADMIN_TOKEN must be set}");
    expect(out.composeFile).toContain("${OPENPALM_WORK_HOME:-${HOME}/openpalm}:/work");
    expect(out.composeFile).toContain("user: \"${OPENPALM_UID:-1000}:${OPENPALM_GID:-1000}\"");
    expect(out.composeFile).toContain("gateway:");
    expect(out.composeFile).toContain("${OPENPALM_DATA_HOME}:/data");
    expect(out.composeFile).toContain("channel-discord:");
    expect(out.composeFile).toContain("\"8181:8181\"");
  });

  it("generates valid Caddy JSON with expected structure", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    expect(caddyConfig.admin.disabled).toBe(true);
    expect(caddyConfig.apps.http.servers.main).toBeDefined();
    expect(Array.isArray(caddyConfig.apps.http.servers.main.routes)).toBe(true);
    expect(caddyConfig.apps.http.servers.main.routes.length).toBeGreaterThan(0);
  });

  it("generates hostname route for localhost in Caddy JSON", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;

    // Find host-based routes
    const hostRoutes = routes.filter((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) => Array.isArray(m.host))
    );
    const hostnames = hostRoutes.flatMap((r: Record<string, unknown>) =>
      (r.match as Array<Record<string, unknown>>).flatMap((m: Record<string, unknown>) => m.host)
    );
    expect(hostnames).toContain("localhost");
    expect(hostnames).not.toContain("assistant");
    expect(hostnames).not.toContain("admin");
    expect(hostnames).not.toContain("openmemory");
  });

  it("generates admin subroute with expected sub-handlers", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;

    // Find the /api* route
    const adminRoute = routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/api*")
      )
    );
    expect(adminRoute).toBeDefined();
    expect(adminRoute.terminal).toBe(true);

    // Check subroute handler exists
    const subrouteHandler = adminRoute.handle[0];
    expect(subrouteHandler.handler).toBe("subroute");
    expect(Array.isArray(subrouteHandler.routes)).toBe(true);
  });

  it("skips disabled channels in generated artifacts", () => {
    const spec = createDefaultStackSpec();
    spec.channels.discord.enabled = false;
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    // No /channels/discord* route should exist
    const routes = caddyConfig.apps.http.servers.main.routes;
    const discordRoute = routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).some((p: string) => p.includes("discord"))
      )
    );
    expect(discordRoute).toBeUndefined();
    expect(out.composeFile).not.toContain("channel-discord:");
  });

  it("generates channel env artifacts from direct secret references", () => {
    const spec = createDefaultStackSpec();
    spec.channels.chat.config.CHAT_INBOUND_TOKEN = "${CHAT_TOKEN_SECRET}";
    spec.channels.chat.config.CHANNEL_CHAT_SECRET = "${CHANNEL_CHAT_SECRET_VALUE}";
    const out = generateStackArtifacts(spec, {
      CHAT_TOKEN_SECRET: "chat-token",
      CHANNEL_CHAT_SECRET_VALUE: "chat-secret",
    });
    expect(out.gatewayEnv).not.toContain("CHANNEL_CHAT_SECRET=chat-secret");
    expect(out.channelEnvs["channel-chat"]).toContain("CHANNEL_CHAT_SECRET=chat-secret");
    expect(out.channelEnvs["channel-chat"]).toContain("CHAT_INBOUND_TOKEN=chat-token");
  });

  it("renders host exposure channel routes with host-only IP guard in Caddy JSON", () => {
    const spec = createDefaultStackSpec();
    spec.channels.chat.exposure = "host";
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;
    const chatRoute = routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/channels/chat*")
      )
    );
    expect(chatRoute).toBeDefined();
    // The subroute should contain a guard with host-only ranges
    const subroute = chatRoute.handle[0];
    expect(subroute.handler).toBe("subroute");
    const guardRoute = subroute.routes[0];
    expect(guardRoute.match[0].not).toBeDefined();
  });

  it("binds host exposure channels to loopback while lan/public bind on all interfaces", () => {
    const spec = createDefaultStackSpec();
    spec.channels.chat.exposure = "host";
    spec.channels.discord.exposure = "lan";
    const out = generateStackArtifacts(spec, {});
    expect(out.composeFile).toContain("\"127.0.0.1:8181:8181\"");
    expect(out.composeFile).toContain("\"8184:8184\"");
  });

  it("fails when a channel secret reference cannot be resolved", () => {
    const spec = createDefaultStackSpec();
    spec.channels.chat.config.CHAT_INBOUND_TOKEN = "${MISSING_SECRET}";
    expect(() => generateStackArtifacts(spec, {})).toThrow("unresolved_secret_reference_chat_CHAT_INBOUND_TOKEN_MISSING_SECRET");
  });

  // --- New: custom channel support ---

  it("renders custom channels with their own image and ports", () => {
    const spec = createDefaultStackSpec();
    spec.channels["public-api"] = {
      enabled: true,
      exposure: "public",
      image: "ghcr.io/acme/api:latest",
      containerPort: 9000,
      hostPort: 9001,
      config: {},
    };
    const out = generateStackArtifacts(spec, {});
    expect(out.composeFile).toContain("channel-public-api:");
    expect(out.composeFile).toContain("image: ghcr.io/acme/api:latest");
    expect(out.composeFile).toContain("PORT=9000");
    expect(out.composeFile).toContain("\"9001:9000\"");
  });

  it("renders custom channels with host exposure on loopback", () => {
    const spec = createDefaultStackSpec();
    spec.channels["internal-svc"] = {
      enabled: true,
      exposure: "host",
      image: "my-svc:latest",
      containerPort: 7000,
      config: {},
    };
    const out = generateStackArtifacts(spec, {});
    expect(out.composeFile).toContain("\"127.0.0.1:7000:7000\"");
  });

  it("generates domain-based Caddy JSON routes for channels with domains", () => {
    const spec = createDefaultStackSpec();
    spec.channels["public-api"] = {
      enabled: true,
      exposure: "public",
      image: "ghcr.io/acme/api:latest",
      containerPort: 9000,
      domains: ["api.example.com"],
      pathPrefixes: ["/api", "/"],
      config: {},
    };
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    // Should have a tls_domains server for HTTPS
    expect(caddyConfig.apps.http.servers.tls_domains).toBeDefined();
    const domainRoutes = caddyConfig.apps.http.servers.tls_domains.routes;
    expect(domainRoutes.length).toBeGreaterThan(0);
    // Should have host matcher for api.example.com
    const domainRoute = domainRoutes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.host) && (m.host as string[]).includes("api.example.com")
      )
    );
    expect(domainRoute).toBeDefined();
    // Domain-routed channels should not generate path-based route in main server
    const mainRoutes = caddyConfig.apps.http.servers.main.routes;
    const pathRoute = mainRoutes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).some((p: string) => p.includes("public-api"))
      )
    );
    expect(pathRoute).toBeUndefined();
  });

  it("generates IP guard for lan domain channels", () => {
    const spec = createDefaultStackSpec();
    spec.channels["admin-panel"] = {
      enabled: true,
      exposure: "lan",
      image: "admin:latest",
      containerPort: 3000,
      domains: ["admin.local"],
      config: {},
    };
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    expect(caddyConfig.apps.http.servers.tls_domains).toBeDefined();
    const domainRoutes = caddyConfig.apps.http.servers.tls_domains.routes;
    const adminRoute = domainRoutes[0];
    // Subroute should have an IP guard
    const subroute = adminRoute.handle[0];
    expect(subroute.handler).toBe("subroute");
    const guardRoute = subroute.routes[0];
    expect(guardRoute.match[0].not).toBeDefined();
    expect(guardRoute.handle[0].handler).toBe("static_response");
  });

  it("generates IP guard for host domain channels", () => {
    const spec = createDefaultStackSpec();
    spec.channels["debug-panel"] = {
      enabled: true,
      exposure: "host",
      image: "debug:latest",
      containerPort: 3000,
      domains: ["debug.local"],
      config: {},
    };
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    expect(caddyConfig.apps.http.servers.tls_domains).toBeDefined();
    const domainRoutes = caddyConfig.apps.http.servers.tls_domains.routes;
    const debugRoute = domainRoutes[0];
    const subroute = debugRoute.handle[0];
    const guardRoute = subroute.routes[0];
    // Host guard should only have 127.0.0.0/8 and ::1
    const negatedRanges = guardRoute.match[0].not[0].remote_ip.ranges;
    expect(negatedRanges).toContain("127.0.0.0/8");
    expect(negatedRanges).toContain("::1");
    expect(negatedRanges).not.toContain("10.0.0.0/8");
  });

  it("no IP guard for public domain channels", () => {
    const spec = createDefaultStackSpec();
    spec.channels["public-api"] = {
      enabled: true,
      exposure: "public",
      image: "api:latest",
      containerPort: 9000,
      domains: ["api.example.com"],
      config: {},
    };
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const domainRoutes = caddyConfig.apps.http.servers.tls_domains.routes;
    const apiRoute = domainRoutes[0];
    const subroute = apiRoute.handle[0];
    // Public domain: should not have a guard route (no "not" matcher with static_response)
    const hasGuard = subroute.routes.some((r: Record<string, unknown>) =>
      Array.isArray(r.handle) && (r.handle as Array<Record<string, unknown>>).some((h: Record<string, unknown>) => h.handler === "static_response")
    );
    expect(hasGuard).toBe(false);
  });

  it("includes caddy TLS config when email is configured", () => {
    const spec = createDefaultStackSpec();
    spec.caddy = { email: "admin@example.com" };
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    expect(caddyConfig.apps.tls).toBeDefined();
    expect(caddyConfig.apps.tls.automation.policies[0].issuers[0].email).toBe("admin@example.com");
  });

  it("does not include TLS config when caddy config is absent", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    expect(caddyConfig.apps.tls).toBeUndefined();
  });

  it("uses LAN ranges in guard matchers for default scope", () => {
    const spec = createDefaultStackSpec();
    spec.accessScope = "public";
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    // The default catch-all route should use LAN ranges in its guard
    const json = JSON.stringify(caddyConfig);
    expect(json).toContain("192.168.0.0/16");
  });

  it("allows built-in channels to override image and port", () => {
    const spec = createDefaultStackSpec();
    spec.channels.chat.image = "custom-chat:v2";
    spec.channels.chat.containerPort = 9999;
    spec.channels.chat.hostPort = 19999;
    const out = generateStackArtifacts(spec, {});
    expect(out.composeFile).toContain("image: custom-chat:v2");
    expect(out.composeFile).toContain("PORT=9999");
    expect(out.composeFile).toContain("\"19999:9999\"");
  });

  it("resolves custom channel config secrets", () => {
    const spec = createDefaultStackSpec();
    spec.channels["slack"] = {
      enabled: true,
      exposure: "lan",
      image: "slack-adapter:latest",
      containerPort: 8500,
      config: { SLACK_TOKEN: "${MY_SLACK_TOKEN}" },
    };
    const out = generateStackArtifacts(spec, { MY_SLACK_TOKEN: "xoxb-test" });
    expect(out.channelEnvs["channel-slack"]).toContain("SLACK_TOKEN=xoxb-test");
  });

  it("generates path-based routes for custom channels without domains", () => {
    const spec = createDefaultStackSpec();
    spec.channels["webhook"] = {
      enabled: true,
      exposure: "lan",
      image: "webhook:latest",
      containerPort: 8600,
      config: {},
    };
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;
    const webhookRoute = routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/channels/webhook*")
      )
    );
    expect(webhookRoute).toBeDefined();
    // Should have reverse_proxy to channel-webhook:8600
    const json = JSON.stringify(webhookRoute);
    expect(json).toContain("channel-webhook:8600");
    // Should have LAN guard
    expect(json).toContain("static_response");
  });

  it("uses rewrite for built-in channels in Caddy JSON", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;
    const chatRoute = routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/channels/chat*")
      )
    );
    expect(chatRoute).toBeDefined();
    // Should have rewrite handler with uri: /chat
    const json = JSON.stringify(chatRoute);
    expect(json).toContain("/chat");
    expect(json).toContain("rewrite");
  });

  it("includes admin service env vars needed for compose and service discovery", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    expect(out.composeFile).toContain("GATEWAY_URL=http://gateway:8080");
    expect(out.composeFile).toContain("OPENCODE_CORE_URL=http://assistant:4096");
    expect(out.composeFile).toContain("OPENPALM_COMPOSE_BIN=");
    expect(out.composeFile).toContain("OPENPALM_COMPOSE_SUBCOMMAND=");
    expect(out.composeFile).toContain("OPENPALM_CONTAINER_SOCKET_URI=");
  });

  it("includes healthchecks for core services", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    expect(out.composeFile).toContain("test: [\"CMD\", \"curl\", \"-fs\", \"http://localhost:4096/\"]");
    expect(out.composeFile).toContain("test: [\"CMD\", \"curl\", \"-fs\", \"http://localhost:8080/health\"]");
    expect(out.composeFile).toContain("test: [\"CMD\", \"curl\", \"-fs\", \"http://localhost:8100/health\"]");
  });

  // --- Multi-channel artifact generation with unique requirements ---

  it("generates correct compose services for multiple custom channels with diverse configs", () => {
    const spec = createDefaultStackSpec();
    spec.channels.discord.enabled = false;
    spec.channels.voice.enabled = false;
    spec.channels.telegram.enabled = false;

    spec.channels["slack"] = {
      enabled: true,
      exposure: "lan",
      image: "openpalm/channel-slack:latest",
      containerPort: 8500,
      config: { SLACK_BOT_TOKEN: "${SLACK_TOKEN}", SLACK_SIGNING_SECRET: "inline-secret" },
    };
    spec.channels["whatsapp"] = {
      enabled: true,
      exposure: "public",
      image: "ghcr.io/acme/wa-bridge:v2",
      containerPort: 9200,
      hostPort: 9201,
      domains: ["wa.example.com"],
      config: { WA_PHONE_ID: "12345" },
    };
    spec.channels["internal-api"] = {
      enabled: true,
      exposure: "host",
      image: "my-api:latest",
      containerPort: 3000,
      config: {},
    };

    const out = generateStackArtifacts(spec, { SLACK_TOKEN: "xoxb-test-123" });

    expect(out.composeFile).toContain("channel-slack:");
    expect(out.composeFile).toContain("image: openpalm/channel-slack:latest");
    expect(out.composeFile).toContain("channel-whatsapp:");
    expect(out.composeFile).toContain("image: ghcr.io/acme/wa-bridge:v2");
    expect(out.composeFile).toContain("channel-internal-api:");
    expect(out.composeFile).toContain("image: my-api:latest");
    expect(out.composeFile).toContain("\"127.0.0.1:3000:3000\"");
    expect(out.composeFile).toContain("\"9201:9200\"");
    expect(out.composeFile).toContain("\"8500:8500\"");
    expect(out.composeFile).toContain("channel-chat:");
    expect(out.composeFile).not.toContain("channel-discord:");
  });

  it("generates correct Caddy JSON routing for channels with different routing strategies", () => {
    const spec = createDefaultStackSpec();
    spec.channels.discord.enabled = false;
    spec.channels.voice.enabled = false;
    spec.channels.telegram.enabled = false;

    spec.channels["slack"] = {
      enabled: true,
      exposure: "lan",
      image: "slack:latest",
      containerPort: 8500,
      config: {},
    };
    spec.channels["whatsapp"] = {
      enabled: true,
      exposure: "public",
      image: "wa:latest",
      containerPort: 9200,
      domains: ["wa.example.com"],
      pathPrefixes: ["/webhook"],
      config: {},
    };
    spec.channels["debug-svc"] = {
      enabled: true,
      exposure: "host",
      image: "debug:latest",
      containerPort: 3000,
      config: {},
    };

    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);

    // Path-based slack channel should be in main routes
    const mainRoutes = caddyConfig.apps.http.servers.main.routes;
    const slackRoute = mainRoutes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/channels/slack*")
      )
    );
    expect(slackRoute).toBeDefined();
    const slackJson = JSON.stringify(slackRoute);
    expect(slackJson).toContain("channel-slack:8500");
    expect(slackJson).toContain("static_response"); // LAN guard

    // Domain-based whatsapp should be in tls_domains server
    expect(caddyConfig.apps.http.servers.tls_domains).toBeDefined();
    const domainRoutes = caddyConfig.apps.http.servers.tls_domains.routes;
    const waRoute = domainRoutes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.host) && (m.host as string[]).includes("wa.example.com")
      )
    );
    expect(waRoute).toBeDefined();

    // Host-only debug-svc should be in main routes with host guard
    const debugRoute = mainRoutes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/channels/debug-svc*")
      )
    );
    expect(debugRoute).toBeDefined();
    const debugJson = JSON.stringify(debugRoute);
    expect(debugJson).toContain("static_response"); // host guard
  });

  it("resolves config secrets independently per custom channel", () => {
    const spec = createDefaultStackSpec();
    spec.channels["svc-a"] = {
      enabled: true,
      exposure: "lan",
      image: "a:latest",
      containerPort: 7000,
      config: { SVC_A_KEY: "${SECRET_A}", SVC_A_URL: "https://a.example.com" },
    };
    spec.channels["svc-b"] = {
      enabled: true,
      exposure: "lan",
      image: "b:latest",
      containerPort: 7001,
      config: { SVC_B_KEY: "${SECRET_B}", SVC_B_MODE: "production" },
    };

    const out = generateStackArtifacts(spec, {
      SECRET_A: "key-for-a",
      SECRET_B: "key-for-b",
    });

    expect(out.channelEnvs["channel-svc-a"]).toContain("SVC_A_KEY=key-for-a");
    expect(out.channelEnvs["channel-svc-a"]).toContain("SVC_A_URL=https://a.example.com");
    expect(out.channelEnvs["channel-svc-b"]).toContain("SVC_B_KEY=key-for-b");
    expect(out.channelEnvs["channel-svc-b"]).toContain("SVC_B_MODE=production");
  });

  it("fails if any one custom channel has an unresolved secret", () => {
    const spec = createDefaultStackSpec();
    spec.channels["good-svc"] = {
      enabled: true,
      exposure: "lan",
      image: "good:latest",
      containerPort: 7000,
      config: { GOOD_KEY: "${RESOLVED_SECRET}" },
    };
    spec.channels["bad-svc"] = {
      enabled: true,
      exposure: "lan",
      image: "bad:latest",
      containerPort: 7001,
      config: { BAD_KEY: "${MISSING_SECRET}" },
    };

    expect(() => generateStackArtifacts(spec, { RESOLVED_SECRET: "ok" }))
      .toThrow("unresolved_secret_reference_bad-svc_BAD_KEY_MISSING_SECRET");
  });

  it("generates systemEnv with access scope and enabled channel service names", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    expect(out.systemEnv).toContain("OPENPALM_ACCESS_SCOPE=lan");
    expect(out.systemEnv).toContain("OPENPALM_ENABLED_CHANNELS=");
    expect(out.systemEnv).toContain("channel-chat");
    expect(out.systemEnv).toContain("channel-discord");
  });

  it("systemEnv reflects accessScope from spec", () => {
    const spec = createDefaultStackSpec();
    spec.accessScope = "host";
    const out = generateStackArtifacts(spec, {});
    expect(out.systemEnv).toContain("OPENPALM_ACCESS_SCOPE=host");
  });

  it("systemEnv OPENPALM_ENABLED_CHANNELS excludes disabled channels", () => {
    const spec = createDefaultStackSpec();
    spec.channels.discord.enabled = false;
    spec.channels.voice.enabled = false;
    const out = generateStackArtifacts(spec, {});
    expect(out.systemEnv).toContain("channel-chat");
    expect(out.systemEnv).toContain("channel-telegram");
    expect(out.systemEnv).not.toContain("channel-discord");
    expect(out.systemEnv).not.toContain("channel-voice");
  });

  it("systemEnv is empty-channels string when all channels disabled", () => {
    const spec = createDefaultStackSpec();
    for (const name of Object.keys(spec.channels)) spec.channels[name].enabled = false;
    const out = generateStackArtifacts(spec, {});
    expect(out.systemEnv).toContain("OPENPALM_ENABLED_CHANNELS=\n");
  });

  it("generated compose loads system.env for admin and gateway", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const matches = out.composeFile.match(/\$\{OPENPALM_STATE_HOME\}\/system\.env/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("produces clean compose output with no channels enabled", () => {
    const spec = createDefaultStackSpec();
    for (const name of Object.keys(spec.channels)) {
      spec.channels[name].enabled = false;
    }
    const out = generateStackArtifacts(spec, {});
    expect(out.composeFile).toContain("networks:");
    expect(out.composeFile).not.toContain("\n\n\n\n");
  });

  it("caddy compose service mounts caddy.json and uses JSON config command", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    expect(out.composeFile).toContain("caddy.json:/etc/caddy/caddy.json:ro");
    expect(out.composeFile).toContain("caddy run --config /etc/caddy/caddy.json");
    expect(out.composeFile).not.toContain("Caddyfile");
    expect(out.composeFile).not.toContain("snippets");
  });

  it("generates default catch-all route to admin", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;
    const lastRoute = routes[routes.length - 1];
    // Last route should be catch-all (no match) proxying to admin:8100
    expect(lastRoute.match).toBeUndefined();
    const json = JSON.stringify(lastRoute);
    expect(json).toContain("admin:8100");
  });

  // --- Gap coverage: admin subroute sub-handlers ---

  it("admin subroute contains /services/opencode* route proxying to assistant", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;
    const adminRoute = routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/api*")
      )
    );
    const subroute = adminRoute.handle[0];
    const opencodeRoute = subroute.routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/services/opencode*")
      )
    );
    expect(opencodeRoute).toBeDefined();
    const json = JSON.stringify(opencodeRoute);
    expect(json).toContain("/services/opencode");
    expect(json).toContain("assistant:4096");
  });

  it("admin subroute contains /services/openmemory* route proxying to openmemory-ui", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;
    const adminRoute = routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/api*")
      )
    );
    const subroute = adminRoute.handle[0];
    const omRoute = subroute.routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/services/openmemory*")
      )
    );
    expect(omRoute).toBeDefined();
    const json = JSON.stringify(omRoute);
    expect(json).toContain("/services/openmemory");
    expect(json).toContain("openmemory-ui:3000");
  });

  it("admin subroute contains /api* route rewriting to root", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;
    const adminRoute = routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/api*")
      )
    );
    const subroute = adminRoute.handle[0];
    const apiRoute = subroute.routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/api*")
      )
    );
    expect(apiRoute).toBeDefined();
    const json = JSON.stringify(apiRoute);
    expect(json).toContain('"strip_path_prefix":"/api"');
    expect(json).toContain("admin:8100");
  });

  // --- Gap coverage: host accessScope guard ranges ---

  it("catch-all route guard uses only loopback ranges when accessScope is host", () => {
    const spec = createDefaultStackSpec();
    spec.accessScope = "host";
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;
    const lastRoute = routes[routes.length - 1];
    const subroute = lastRoute.handle[0];
    const guardRoute = subroute.routes[0];
    const negatedRanges = guardRoute.match[0].not[0].remote_ip.ranges;
    expect(negatedRanges).toContain("127.0.0.0/8");
    expect(negatedRanges).toContain("::1");
    expect(negatedRanges).not.toContain("10.0.0.0/8");
    expect(negatedRanges).not.toContain("192.168.0.0/16");
  });

  it("core hostname routes use host-only guard ranges when accessScope is host", () => {
    const spec = createDefaultStackSpec();
    spec.accessScope = "host";
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;
    // Find the localhost hostname route
    const localhostRoute = routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.host) && (m.host as string[]).includes("localhost")
      )
    );
    expect(localhostRoute).toBeDefined();
    const subroute = localhostRoute.handle[0];
    const guardRoute = subroute.routes[0];
    const negatedRanges = guardRoute.match[0].not[0].remote_ip.ranges;
    expect(negatedRanges).toEqual(["127.0.0.0/8", "::1"]);
  });

  // --- Gap coverage: multiple domains on a single channel ---

  it("uses all domains from channel config in domain route matcher", () => {
    const spec = createDefaultStackSpec();
    spec.channels["multi-domain"] = {
      enabled: true,
      exposure: "public",
      image: "multi:latest",
      containerPort: 9000,
      domains: ["api.example.com", "api2.example.com", "api3.example.com"],
      config: {},
    };
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    expect(caddyConfig.apps.http.servers.tls_domains).toBeDefined();
    const domainRoutes = caddyConfig.apps.http.servers.tls_domains.routes;
    const multiRoute = domainRoutes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.host) && (m.host as string[]).includes("api.example.com")
      )
    );
    expect(multiRoute).toBeDefined();
    const hosts = multiRoute.match[0].host;
    expect(hosts).toContain("api.example.com");
    expect(hosts).toContain("api2.example.com");
    expect(hosts).toContain("api3.example.com");
  });

  // --- Gap coverage: public channel has no IP guard in path route ---

  it("public channel path route has no IP guard", () => {
    const spec = createDefaultStackSpec();
    spec.channels["open-api"] = {
      enabled: true,
      exposure: "public",
      image: "open:latest",
      containerPort: 7000,
      config: {},
    };
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;
    const openRoute = routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/channels/open-api*")
      )
    );
    expect(openRoute).toBeDefined();
    const subroute = openRoute.handle[0];
    const hasGuard = subroute.routes.some((r: Record<string, unknown>) =>
      Array.isArray(r.handle) && (r.handle as Array<Record<string, unknown>>).some((h: Record<string, unknown>) => h.handler === "static_response")
    );
    expect(hasGuard).toBe(false);
  });

  // --- Gap coverage: custom channel strips path prefix ---

  it("custom channel path route strips /channels/<name> prefix", () => {
    const spec = createDefaultStackSpec();
    spec.channels["my-hook"] = {
      enabled: true,
      exposure: "lan",
      image: "hook:latest",
      containerPort: 5000,
      config: {},
    };
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;
    const hookRoute = routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/channels/my-hook*")
      )
    );
    expect(hookRoute).toBeDefined();
    const json = JSON.stringify(hookRoute);
    expect(json).toContain("strip_path_prefix");
    expect(json).toContain("/channels/my-hook");
  });
});
