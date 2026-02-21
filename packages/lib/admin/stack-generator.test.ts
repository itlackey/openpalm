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

  it("fails when a channel secret reference cannot be resolved", () => {
    const spec = createDefaultStackSpec();
    spec.channels.chat.config.CHAT_INBOUND_TOKEN = "${MISSING_SECRET}";
    expect(() => generateStackArtifacts(spec, {})).toThrow("unresolved_secret_reference_chat_CHAT_INBOUND_TOKEN_MISSING_SECRET");
  });
});
