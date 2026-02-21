import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { StackManager } from "./stack-manager.ts";

function createManager(dir: string) {
  return new StackManager({
    stateRootPath: dir,
    caddyfilePath: join(dir, "Caddyfile"),
    caddyJsonPath: join(dir, "caddy.json"),
    caddyRoutesDir: join(dir, "routes"),
    composeFilePath: join(dir, "docker-compose.yml"),
    systemEnvPath: join(dir, "system.env"),
    secretsEnvPath: join(dir, "secrets.env"),
    stackSpecPath: join(dir, "stack-spec.json"),
    gatewayEnvPath: join(dir, "gateway", ".env"),
    openmemoryEnvPath: join(dir, "openmemory", ".env"),
    postgresEnvPath: join(dir, "postgres", ".env"),
    qdrantEnvPath: join(dir, "qdrant", ".env"),
    assistantEnvPath: join(dir, "assistant", ".env"),
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
    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain("assistant:");
    expect(readFileSync(join(dir, "gateway", ".env"), "utf8")).toContain("CHANNEL_CHAT_SECRET=abc12345678901234567890123456789");
    expect(readFileSync(join(dir, "channel-chat", ".env"), "utf8")).toContain("CHAT_INBOUND_TOKEN=abc");
    expect(readFileSync(join(dir, "channel-discord", ".env"), "utf8")).toContain("# Generated channel env (discord)");
  });

  it("creates all required directories from scratch when they do not pre-exist", () => {
    // Uses nested paths that mirror production (e.g. /state/rendered/caddy/) with NO pre-created dirs.
    // This test would have failed before the renderArtifacts() mkdir fix.
    const dir = mkdtempSync(join(tmpdir(), "openpalm-mkdir-test-"));
    const manager = new StackManager({
      stateRootPath: dir,
      caddyfilePath: join(dir, "rendered", "caddy", "Caddyfile"),
      caddyJsonPath: join(dir, "rendered", "caddy", "caddy.json"),
      caddyRoutesDir: join(dir, "rendered", "caddy", "snippets"),
      composeFilePath: join(dir, "rendered", "docker-compose.yml"),
      systemEnvPath: join(dir, "system.env"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "stack-spec.json"),
      gatewayEnvPath: join(dir, "gateway", ".env"),
      openmemoryEnvPath: join(dir, "openmemory", ".env"),
      postgresEnvPath: join(dir, "postgres", ".env"),
      qdrantEnvPath: join(dir, "qdrant", ".env"),
      assistantEnvPath: join(dir, "assistant", ".env"),
    });

    expect(() => manager.renderArtifacts()).not.toThrow();
    expect(existsSync(join(dir, "rendered", "caddy", "Caddyfile"))).toBeTrue();
    expect(existsSync(join(dir, "rendered", "caddy", "caddy.json"))).toBeTrue();
    expect(existsSync(join(dir, "rendered", "docker-compose.yml"))).toBeTrue();
    expect(existsSync(join(dir, "system.env"))).toBeTrue();
    expect(existsSync(join(dir, "gateway", ".env"))).toBeTrue();
  });

  it("writes system.env with access scope and enabled channels", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    manager.renderArtifacts();

    const systemEnv = readFileSync(join(dir, "system.env"), "utf8");
    expect(systemEnv).toContain("OPENPALM_ACCESS_SCOPE=lan");
    expect(systemEnv).toContain("OPENPALM_ENABLED_CHANNELS=");
  });

  it("system.env updates when access scope changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    manager.setAccessScope("host");

    const systemEnv = readFileSync(join(dir, "system.env"), "utf8");
    expect(systemEnv).toContain("OPENPALM_ACCESS_SCOPE=host");
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

  // --- Full lifecycle: managing arbitrary custom channels ---

  it("adds a custom channel via setSpec and produces correct artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    const spec = manager.getSpec();
    spec.channels["slack"] = {
      enabled: true,
      exposure: "lan",
      image: "openpalm/channel-slack:latest",
      containerPort: 8500,
      config: { SLACK_BOT_TOKEN: "test-token", SLACK_SIGNING_SECRET: "test-secret" },
    };
    manager.setSpec(spec);

    // Compose contains the new service
    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
    expect(compose).toContain("channel-slack:");
    expect(compose).toContain("image: openpalm/channel-slack:latest");
    expect(compose).toContain("PORT=8500");

    // Caddy route is created
    const route = readFileSync(join(dir, "routes", "channels", "slack.caddy"), "utf8");
    expect(route).toContain("handle_path /channels/slack*");
    expect(route).toContain("reverse_proxy channel-slack:8500");

    // Channels env contains the config values
    const channelsEnv = readFileSync(join(dir, "channel-slack", ".env"), "utf8");
    expect(channelsEnv).toContain("SLACK_BOT_TOKEN=test-token");
    expect(channelsEnv).toContain("SLACK_SIGNING_SECRET=test-secret");
  });

  it("manages config for custom channels independently from built-in channels", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    // Add a custom channel
    const spec = manager.getSpec();
    spec.channels["webhook-relay"] = {
      enabled: true,
      exposure: "lan",
      image: "webhook-relay:latest",
      containerPort: 7000,
      config: { RELAY_TARGET: "https://target.example.com", AUTH_HEADER: "Bearer xyz" },
    };
    manager.setSpec(spec);

    // Read config back
    const config = manager.getChannelConfig("webhook-relay");
    expect(config.RELAY_TARGET).toBe("https://target.example.com");
    expect(config.AUTH_HEADER).toBe("Bearer xyz");

    // Update config with setChannelConfig (custom channels allow arbitrary key changes)
    manager.setChannelConfig("webhook-relay", {
      RELAY_TARGET: "https://new-target.example.com",
      AUTH_HEADER: "Bearer new-token",
      NEW_KEY: "added-value",
    });

    const updatedConfig = manager.getChannelConfig("webhook-relay");
    expect(updatedConfig.RELAY_TARGET).toBe("https://new-target.example.com");
    expect(updatedConfig.NEW_KEY).toBe("added-value");

    // Channels env reflects the updated config
    const channelsEnv = readFileSync(join(dir, "channel-webhook-relay", ".env"), "utf8");
    expect(channelsEnv).toContain("RELAY_TARGET=https://new-target.example.com");
    expect(channelsEnv).toContain("NEW_KEY=added-value");
  });

  it("manages exposure levels for custom channels via setChannelAccess", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    const spec = manager.getSpec();
    spec.channels["my-api"] = {
      enabled: true,
      exposure: "lan",
      image: "api:latest",
      containerPort: 3000,
      config: {},
    };
    manager.setSpec(spec);

    expect(manager.getChannelAccess("my-api")).toBe("lan");

    // Change to host
    manager.setChannelAccess("my-api", "host");
    expect(manager.getChannelAccess("my-api")).toBe("host");

    // Route reflects the change
    const route = readFileSync(join(dir, "routes", "channels", "my-api.caddy"), "utf8");
    expect(route).toContain("abort @not_host");

    // Compose reflects loopback binding
    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
    expect(compose).toContain("\"127.0.0.1:3000:3000\"");

    // Change to public (no guard)
    manager.setChannelAccess("my-api", "public");
    const publicRoute = readFileSync(join(dir, "routes", "channels", "my-api.caddy"), "utf8");
    expect(publicRoute).not.toContain("abort");
  });

  it("lists custom channels alongside built-in channels", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    const spec = manager.getSpec();
    spec.channels["slack"] = {
      enabled: true, exposure: "lan",
      image: "slack:latest", containerPort: 8500, config: {},
    };
    spec.channels["matrix"] = {
      enabled: false, exposure: "lan",
      image: "matrix:latest", containerPort: 8600, config: {},
    };
    manager.setSpec(spec);

    const names = manager.listChannelNames();
    expect(names).toContain("chat");
    expect(names).toContain("discord");
    expect(names).toContain("slack");
    expect(names).toContain("matrix");

    // Only enabled channels appear in enabledChannelServiceNames
    const enabled = manager.enabledChannelServiceNames();
    expect(enabled).toContain("channel-chat");
    expect(enabled).toContain("channel-slack");
    expect(enabled).not.toContain("channel-matrix");
  });

  it("removes custom channel route files when channel is disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    const spec = manager.getSpec();
    spec.channels["temp-svc"] = {
      enabled: true, exposure: "lan",
      image: "temp:latest", containerPort: 7777, config: {},
    };
    manager.setSpec(spec);
    expect(existsSync(join(dir, "routes", "channels", "temp-svc.caddy"))).toBeTrue();

    // Disable the custom channel
    const updated = manager.getSpec();
    updated.channels["temp-svc"].enabled = false;
    manager.setSpec(updated);
    expect(existsSync(join(dir, "routes", "channels", "temp-svc.caddy"))).toBeFalse();
  });

  it("removes custom channel from compose when channel is removed from spec", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    const spec = manager.getSpec();
    spec.channels["ephemeral"] = {
      enabled: true, exposure: "lan",
      image: "ephemeral:latest", containerPort: 6000, config: {},
    };
    manager.setSpec(spec);
    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain("channel-ephemeral:");

    // Remove the channel entirely from spec
    const updated = manager.getSpec();
    delete updated.channels["ephemeral"];
    manager.setSpec(updated);

    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("channel-ephemeral:");
    expect(existsSync(join(dir, "routes", "channels", "ephemeral.caddy"))).toBeFalse();
  });

  it("custom channel secrets are validated by validateReferencedSecrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    writeFileSync(join(dir, "secrets.env"), "KNOWN_SECRET=value\n", "utf8");
    writeFileSync(join(dir, "stack-spec.json"), JSON.stringify({
      version: 2,
      accessScope: "lan",
      channels: {
        chat: { enabled: true, exposure: "lan", config: { CHAT_INBOUND_TOKEN: "", CHANNEL_CHAT_SECRET: "" } },
        discord: { enabled: true, exposure: "lan", config: { DISCORD_BOT_TOKEN: "", DISCORD_PUBLIC_KEY: "", CHANNEL_DISCORD_SECRET: "" } },
        voice: { enabled: true, exposure: "lan", config: { CHANNEL_VOICE_SECRET: "" } },
        telegram: { enabled: true, exposure: "lan", config: { TELEGRAM_BOT_TOKEN: "", TELEGRAM_WEBHOOK_SECRET: "", CHANNEL_TELEGRAM_SECRET: "" } },
        "my-svc": {
          enabled: true, exposure: "lan",
          image: "svc:latest", containerPort: 8000,
          config: {
            GOOD_REF: "${KNOWN_SECRET}",
            BAD_REF: "${UNKNOWN_SECRET}",
          },
        },
      },
      automations: [],
    }, null, 2), "utf8");

    const manager = createManager(dir);
    const errors = manager.validateReferencedSecrets();
    expect(errors).toContain("missing_secret_reference_my-svc_BAD_REF_UNKNOWN_SECRET");
    // GOOD_REF should NOT produce an error since KNOWN_SECRET exists
    expect(errors.filter((e) => e.includes("GOOD_REF"))).toHaveLength(0);
  });

  it("custom channel secrets appear in secret manager state with usage tracking", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    manager.upsertSecret("MY_SVC_TOKEN", "tok-123");
    const spec = manager.getSpec();
    spec.channels["my-svc"] = {
      enabled: true, exposure: "lan",
      image: "svc:latest", containerPort: 8000,
      config: { SVC_TOKEN: "${MY_SVC_TOKEN}" },
    };
    manager.setSpec(spec);

    const state = manager.listSecretManagerState();
    const tokenSecret = state.secrets.find((s) => s.name === "MY_SVC_TOKEN");
    expect(tokenSecret).toBeDefined();
    expect(tokenSecret!.configured).toBe(true);
    expect(tokenSecret!.usedBy).toContain("channel:my-svc:SVC_TOKEN");
  });

  it("prevents deleting secrets referenced by custom channels", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    manager.upsertSecret("CUSTOM_SECRET", "value");
    const spec = manager.getSpec();
    spec.channels["custom-svc"] = {
      enabled: true, exposure: "lan",
      image: "svc:latest", containerPort: 8000,
      config: { MY_KEY: "${CUSTOM_SECRET}" },
    };
    manager.setSpec(spec);

    expect(() => manager.deleteSecret("CUSTOM_SECRET")).toThrow("secret_in_use");
  });

  it("manages multiple custom channels with completely different config shapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    manager.upsertSecret("SLACK_TOKEN", "xoxb-slack");
    manager.upsertSecret("JIRA_API_KEY", "jira-key-123");

    const spec = manager.getSpec();
    spec.channels["slack"] = {
      enabled: true, exposure: "lan",
      image: "slack-adapter:latest", containerPort: 8500,
      config: {
        SLACK_BOT_TOKEN: "${SLACK_TOKEN}",
        SLACK_CHANNEL_ID: "C12345",
        SLACK_THREAD_TS: "",
      },
    };
    spec.channels["jira-webhook"] = {
      enabled: true, exposure: "public",
      image: "jira-hook:v3", containerPort: 9100,
      hostPort: 9101,
      domains: ["jira.example.com"],
      config: {
        JIRA_API_KEY: "${JIRA_API_KEY}",
        JIRA_PROJECT: "PROJ",
        JIRA_ISSUE_TYPE: "Bug",
        JIRA_WEBHOOK_PATH: "/webhook",
      },
    };
    manager.setSpec(spec);

    // Verify compose has both services
    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
    expect(compose).toContain("channel-slack:");
    expect(compose).toContain("channel-jira-webhook:");
    expect(compose).toContain("image: jira-hook:v3");
    expect(compose).toContain("\"9101:9100\"");

    // Verify Caddy: slack gets path-based route, jira gets domain-based block
    expect(existsSync(join(dir, "routes", "channels", "slack.caddy"))).toBeTrue();
    expect(existsSync(join(dir, "routes", "channels", "jira-webhook.caddy"))).toBeFalse();
    const caddyfile = readFileSync(join(dir, "Caddyfile"), "utf8");
    expect(caddyfile).toContain("jira.example.com {");

    // Verify channels env has resolved secrets
    const slackEnv = readFileSync(join(dir, "channel-slack", ".env"), "utf8");
    const jiraEnv = readFileSync(join(dir, "channel-jira-webhook", ".env"), "utf8");
    expect(slackEnv).toContain("SLACK_BOT_TOKEN=xoxb-slack");
    expect(slackEnv).toContain("SLACK_CHANNEL_ID=C12345");
    expect(jiraEnv).toContain("JIRA_API_KEY=jira-key-123");
    expect(jiraEnv).toContain("JIRA_PROJECT=PROJ");
  });
});
