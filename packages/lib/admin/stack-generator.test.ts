import { describe, expect, it } from "bun:test";
import { generateStackArtifacts } from "./stack-generator.ts";
import { createDefaultStackSpec } from "./stack-spec.ts";

describe("stack generator", () => {
  it("renders all core and enabled channel services in compose output", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    expect(out.caddyRoutes["channels/chat.caddy"]).toContain("handle /channels/chat*");
    expect(out.composeFile).toContain("caddy:");
    expect(out.composeFile).toContain("/rendered/caddy/snippets:/etc/caddy/snippets:ro");
    expect(out.composeFile).toContain("opencode-core:");
    expect(out.composeFile).toContain("${OPENPALM_DATA_HOME}/opencode:/home/opencode");
    expect(out.composeFile).toContain("${HOME}/openpalm:/work");
    expect(out.composeFile).toContain("user: \"${OPENPALM_UID:-1000}:${OPENPALM_GID:-1000}\"");
    expect(out.composeFile).toContain("gateway:");
    expect(out.composeFile).toContain("${OPENPALM_DATA_HOME}:/data");
    expect(out.composeFile).toContain("channel-discord:");
    expect(out.composeFile).toContain("\"8181:8181\"");
  });

  it("skips disabled channels in generated artifacts", () => {
    const spec = createDefaultStackSpec();
    spec.channels.discord.enabled = false;
    const out = generateStackArtifacts(spec, {});
    expect(out.caddyRoutes["channels/discord.caddy"]).toBeUndefined();
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
    expect(out.gatewayEnv).toContain("CHANNEL_CHAT_SECRET=chat-secret");
    expect(out.channelsEnv).toContain("CHANNEL_CHAT_SECRET=chat-secret");
    expect(out.channelsEnv).toContain("CHAT_INBOUND_TOKEN=chat-token");
  });

  it("renders host exposure routes with host-only guard", () => {
    const spec = createDefaultStackSpec();
    spec.channels.chat.exposure = "host";
    const out = generateStackArtifacts(spec, {});
    expect(out.caddyfile).toContain("@host remote_ip");
    expect(out.caddyRoutes["channels/chat.caddy"]).toContain("abort @not_host");
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

  it("generates domain-based Caddy blocks for channels with domains", () => {
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
    expect(out.caddyfile).toContain("api.example.com {");
    expect(out.caddyfile).toContain("handle_path /api*");
    expect(out.caddyfile).toContain("reverse_proxy channel-public-api:9000");
    expect(out.caddyfile).not.toContain("tls internal");
    // Domain-routed channels should not generate path-based snippet
    expect(out.caddyRoutes["channels/public-api.caddy"]).toBeUndefined();
  });

  it("generates tls internal and IP guard for lan domain channels", () => {
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
    expect(out.caddyfile).toContain("admin.local {");
    expect(out.caddyfile).toContain("tls internal");
    expect(out.caddyfile).toContain("@not_lan not remote_ip");
    expect(out.caddyfile).toContain("abort @not_lan");
  });

  it("generates tls internal and host guard for host domain channels", () => {
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
    expect(out.caddyfile).toContain("debug.local {");
    expect(out.caddyfile).toContain("tls internal");
    expect(out.caddyfile).toContain("@not_host not remote_ip 127.0.0.0/8 ::1");
    expect(out.caddyfile).toContain("abort @not_host");
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
    expect(out.caddyfile).toContain("api.example.com {");
    expect(out.caddyfile).not.toContain("tls internal");
    // Public domain block should not contain abort directives
    const domainBlock = out.caddyfile.split("api.example.com {")[1].split("}")[0];
    expect(domainBlock).not.toContain("abort");
  });

  it("includes caddy email in global block when configured", () => {
    const spec = createDefaultStackSpec();
    spec.caddy = { email: "admin@example.com" };
    const out = generateStackArtifacts(spec, {});
    expect(out.caddyfile).toContain("email admin@example.com");
  });

  it("does not include email when caddy config is absent", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    expect(out.caddyfile).not.toContain("email");
  });

  it("uses public access scope for LAN matcher", () => {
    const spec = createDefaultStackSpec();
    spec.accessScope = "public";
    const out = generateStackArtifacts(spec, {});
    // public uses the same broad matcher as lan
    expect(out.caddyfile).toContain("192.168.0.0/16");
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
    expect(out.channelsEnv).toContain("SLACK_TOKEN=xoxb-test");
  });

  it("generates path-based routes for custom channels without domains using handle_path", () => {
    const spec = createDefaultStackSpec();
    spec.channels["webhook"] = {
      enabled: true,
      exposure: "lan",
      image: "webhook:latest",
      containerPort: 8600,
      config: {},
    };
    const out = generateStackArtifacts(spec, {});
    expect(out.caddyRoutes["channels/webhook.caddy"]).toContain("handle_path /channels/webhook*");
    expect(out.caddyRoutes["channels/webhook.caddy"]).toContain("reverse_proxy channel-webhook:8600");
    expect(out.caddyRoutes["channels/webhook.caddy"]).toContain("abort @not_lan");
    // Custom channels should NOT have a rewrite directive (handle_path strips prefix)
    expect(out.caddyRoutes["channels/webhook.caddy"]).not.toContain("rewrite");
  });

  it("uses handle+rewrite for built-in channels (not handle_path)", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    expect(out.caddyRoutes["channels/chat.caddy"]).toContain("handle /channels/chat*");
    expect(out.caddyRoutes["channels/chat.caddy"]).toContain("rewrite * /chat");
  });

  it("includes admin service env vars needed for compose and service discovery", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    expect(out.composeFile).toContain("GATEWAY_URL=http://gateway:8080");
    expect(out.composeFile).toContain("OPENCODE_CORE_URL=http://opencode-core:4096");
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

  it("produces clean compose output with no channels enabled", () => {
    const spec = createDefaultStackSpec();
    for (const name of Object.keys(spec.channels)) {
      spec.channels[name].enabled = false;
    }
    const out = generateStackArtifacts(spec, {});
    expect(out.composeFile).toContain("networks:");
    // Should not have triple blank lines
    expect(out.composeFile).not.toContain("\n\n\n\n");
  });
});
