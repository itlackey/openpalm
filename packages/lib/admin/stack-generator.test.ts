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

  it("generates channel env artifacts", () => {
    const spec = createDefaultStackSpec();
    spec.channels.chat.config.CHAT_INBOUND_TOKEN = "chat-token";
    spec.connections.push({
      id: "openai",
      type: "ai_provider",
      name: "OpenAI",
      env: {
        OPENAI_API_KEY: "OPENAI_API_KEY_MAIN",
      },
    });
    const out = generateStackArtifacts(spec, {
      CHANNEL_CHAT_SECRET: "chat-secret",
      CHANNEL_DISCORD_SECRET: "discord-secret",
      CHANNEL_VOICE_SECRET: "voice-secret",
      CHANNEL_TELEGRAM_SECRET: "telegram-secret",
      OPENAI_API_KEY_MAIN: "provider-secret",
    });
    expect(out.gatewayEnv).toContain("CHANNEL_CHAT_SECRET=chat-secret");
    expect(out.gatewayEnv).toContain("OPENAI_API_KEY=provider-secret");
    expect(out.opencodeEnv).toContain("OPENAI_API_KEY=provider-secret");
    expect(out.channelsEnv).toContain("CHANNEL_CHAT_SECRET=chat-secret");
    expect(out.channelsEnv).toContain("CHAT_INBOUND_TOKEN=chat-token");
  });
});
