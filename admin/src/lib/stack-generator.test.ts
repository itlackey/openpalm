import { describe, expect, it } from "bun:test";
import { generateStackArtifacts } from "./stack-generator.ts";
import { createDefaultStackSpec } from "./stack-spec.ts";

describe("stack generator", () => {
  it("renders all core and enabled channel services in compose output", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    expect(out.caddyfile).toContain("handle /channels/chat*");
    expect(out.composeFile).toContain("caddy:");
    expect(out.composeFile).toContain("opencode-core:");
    expect(out.composeFile).toContain("gateway:");
    expect(out.composeFile).toContain("channel-discord:");
  });

  it("skips disabled channels in generated artifacts", () => {
    const spec = createDefaultStackSpec();
    spec.channels.discord.enabled = false;
    const out = generateStackArtifacts(spec, {});
    expect(out.caddyfile).not.toContain("handle /channels/discord*");
    expect(out.composeFile).not.toContain("channel-discord:");
  });

  it("generates opencode plugin config and channel env artifacts", () => {
    const spec = createDefaultStackSpec();
    spec.channels.chat.config.CHAT_INBOUND_TOKEN = "chat-token";
    spec.extensions.push({
      id: "policy-plugin",
      type: "plugin",
      enabled: true,
      pluginId: "@openpalm/policy-plugin",
      connectionIds: [],
    });
    const out = generateStackArtifacts(spec, {
      CHANNEL_CHAT_SECRET: "chat-secret",
      CHANNEL_DISCORD_SECRET: "discord-secret",
      CHANNEL_VOICE_SECRET: "voice-secret",
      CHANNEL_TELEGRAM_SECRET: "telegram-secret",
    });
    expect(out.gatewayChannelSecretsEnv).toContain("CHANNEL_CHAT_SECRET=chat-secret");
    expect(out.channelSecretsEnv.chat).toContain("CHANNEL_CHAT_SECRET=chat-secret");
    expect(out.channelConfigEnv.chat).toContain("CHAT_INBOUND_TOKEN=chat-token");
    expect(out.opencodePluginIds).toContain("@openpalm/policy-plugin");
    expect(out.opencodePluginConfigJsonc).toContain("@openpalm/policy-plugin");
  });
});
