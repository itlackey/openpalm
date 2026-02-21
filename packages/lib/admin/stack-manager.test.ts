import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { StackManager } from "./stack-manager.ts";

function createManager(dir: string) {
  return new StackManager({
    caddyfilePath: join(dir, "Caddyfile"),
    caddyRoutesDir: join(dir, "routes"),
    composeFilePath: join(dir, "docker-compose.yml"),
    secretsEnvPath: join(dir, "secrets.env"),
    stackSpecPath: join(dir, "stack-spec.json"),
    gatewayEnvPath: join(dir, "rendered", "env", "gateway.env"),
    openmemoryEnvPath: join(dir, "rendered", "env", "openmemory.env"),
    postgresEnvPath: join(dir, "rendered", "env", "postgres.env"),
    qdrantEnvPath: join(dir, "rendered", "env", "qdrant.env"),
    opencodeEnvPath: join(dir, "rendered", "env", "opencode.env"),
    channelsEnvPath: join(dir, "rendered", "env", "channels.env"),
  });
}

describe("stack manager", () => {
  it("writes all generated stack artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const caddyDir = join(dir, "caddy");
    mkdirSync(join(caddyDir, "routes"), { recursive: true });
    const manager = createManager(dir);

    manager.upsertSecret("CHAT_TOKEN_SECRET", "abc");
    manager.upsertSecret("CHAT_SHARED_SECRET", "abc12345678901234567890123456789");
    manager.setChannelConfig("chat", {
      CHAT_INBOUND_TOKEN: "${CHAT_TOKEN_SECRET}",
      CHANNEL_CHAT_SECRET: "${CHAT_SHARED_SECRET}",
    });
    manager.renderArtifacts();

    expect(readFileSync(join(dir, "routes", "channels", "chat.caddy"), "utf8")).toContain("handle /channels/chat*");
    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain("opencode-core:");
    expect(readFileSync(join(dir, "rendered", "env", "gateway.env"), "utf8")).toContain("CHANNEL_CHAT_SECRET=abc12345678901234567890123456789");
    expect(readFileSync(join(dir, "rendered", "env", "channels.env"), "utf8")).toContain("CHAT_INBOUND_TOKEN=abc");
  });

  it("prevents deleting secrets that are referenced by channel config", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);
    manager.upsertSecret("CHAT_TOKEN_SECRET", "x");
    manager.setChannelConfig("chat", {
      CHAT_INBOUND_TOKEN: "${CHAT_TOKEN_SECRET}",
      CHANNEL_CHAT_SECRET: "",
    });
    expect(() => manager.deleteSecret("CHAT_TOKEN_SECRET")).toThrow("secret_in_use");
  });

  it("removes stale channel route snippets when channels are disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    manager.renderArtifacts();
    expect(existsSync(join(dir, "routes", "channels", "chat.caddy"))).toBeTrue();

    const spec = manager.getSpec();
    spec.channels.chat.enabled = false;
    manager.setSpec(spec);

    expect(existsSync(join(dir, "routes", "channels", "chat.caddy"))).toBeFalse();
  });

  it("validates missing referenced secrets for enabled channels", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    writeFileSync(join(dir, "secrets.env"), "\n", "utf8");
    writeFileSync(join(dir, "stack-spec.json"), JSON.stringify({
      version: 2,
      accessScope: "lan",
      channels: {
        chat: { enabled: true, exposure: "lan", config: { CHAT_INBOUND_TOKEN: "${MISSING_CHAT_TOKEN}", CHANNEL_CHAT_SECRET: "" } },
        discord: { enabled: true, exposure: "lan", config: { DISCORD_BOT_TOKEN: "", DISCORD_PUBLIC_KEY: "", CHANNEL_DISCORD_SECRET: "" } },
        voice: { enabled: true, exposure: "lan", config: { CHANNEL_VOICE_SECRET: "" } },
        telegram: { enabled: true, exposure: "lan", config: { TELEGRAM_BOT_TOKEN: "", TELEGRAM_WEBHOOK_SECRET: "", CHANNEL_TELEGRAM_SECRET: "" } },
      },
      automations: [],
    }, null, 2), "utf8");
    const manager = createManager(dir);

    expect(manager.validateReferencedSecrets()).toContain("missing_secret_reference_chat_CHAT_INBOUND_TOKEN_MISSING_CHAT_TOKEN");
  });

  it("supports host exposure for channels", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);
    manager.setChannelAccess("chat", "host");
    expect(manager.getChannelAccess("chat")).toBe("host");
  });

  it("preserves multiline automation scripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    const multi = "echo first\necho second";
    manager.upsertAutomation({
      id: "multi",
      name: "Multiline",
      schedule: "0 6 * * *",
      enabled: true,
      script: multi,
    });

    expect(manager.getAutomation("multi")?.script).toBe(multi);
  });
});
