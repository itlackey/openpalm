import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { StackManager } from "./stack-manager.ts";
import { stringifyYamlDocument } from "../shared/yaml.ts";

const yamlStringify = (obj: unknown) => stringifyYamlDocument(obj);

function createManager(dir: string) {
  return new StackManager({
    stateRootPath: dir,
    caddyJsonPath: join(dir, "caddy.json"),
    composeFilePath: join(dir, "docker-compose.yml"),
    runtimeEnvPath: join(dir, ".env"),
    systemEnvPath: join(dir, "system.env"),
    secretsEnvPath: join(dir, "secrets.env"),
    stackSpecPath: join(dir, "openpalm.yaml"),
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
    const manager = createManager(dir);

    manager.upsertSecret("CHAT_TOKEN_SECRET", "abc");
    manager.upsertSecret("CHAT_SHARED_SECRET", "abc12345678901234567890123456789");
    manager.setChannelConfig("chat", {
      CHAT_INBOUND_TOKEN: "${CHAT_TOKEN_SECRET}",
      CHANNEL_CHAT_SECRET: "${CHAT_SHARED_SECRET}",
    });
    manager.renderArtifacts();

    // Caddy JSON is written
    const caddyJson = readFileSync(join(dir, "caddy.json"), "utf8");
    const caddyConfig = JSON.parse(caddyJson);
    expect(caddyConfig.admin.disabled).toBe(true);
    expect(caddyConfig.apps.http.servers.main).toBeDefined();

    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain("assistant:");
    expect(readFileSync(join(dir, "gateway", ".env"), "utf8")).not.toContain("CHANNEL_CHAT_SECRET=abc12345678901234567890123456789");
    expect(readFileSync(join(dir, "channel-chat", ".env"), "utf8")).toContain("CHAT_INBOUND_TOKEN=abc");
    expect(readFileSync(join(dir, "channel-discord", ".env"), "utf8")).toContain("# Generated channel env (discord)");
  });

  it("creates all required directories from scratch when they do not pre-exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-mkdir-test-"));
    const manager = new StackManager({
      stateRootPath: dir,
      caddyJsonPath: join(dir, "caddy.json"),
      composeFilePath: join(dir, "docker-compose.yml"),
      runtimeEnvPath: join(dir, ".env"),
      systemEnvPath: join(dir, "system.env"),
      secretsEnvPath: join(dir, "secrets.env"),
      stackSpecPath: join(dir, "openpalm.yaml"),
      gatewayEnvPath: join(dir, "gateway", ".env"),
      openmemoryEnvPath: join(dir, "openmemory", ".env"),
      postgresEnvPath: join(dir, "postgres", ".env"),
      qdrantEnvPath: join(dir, "qdrant", ".env"),
      assistantEnvPath: join(dir, "assistant", ".env"),
    });

    expect(() => manager.renderArtifacts()).not.toThrow();
    expect(existsSync(join(dir, "caddy.json"))).toBeTrue();
    expect(existsSync(join(dir, "docker-compose.yml"))).toBeTrue();
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

  it("caddy.json updates when channels are disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    manager.renderArtifacts();
    const caddyBefore = readFileSync(join(dir, "caddy.json"), "utf8");
    expect(caddyBefore).toContain("chat");

    const spec = manager.getSpec();
    spec.channels.chat.enabled = false;
    manager.setSpec(spec);

    const caddyAfter = readFileSync(join(dir, "caddy.json"), "utf8");
    // Chat channel route should no longer be in the JSON
    const config = JSON.parse(caddyAfter);
    const json = JSON.stringify(config);
    expect(json).not.toContain("/channels/chat*");
  });

  it("validates missing referenced secrets for enabled channels", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    writeFileSync(join(dir, "secrets.env"), "\n", "utf8");
    writeFileSync(join(dir, "openpalm.yaml"), yamlStringify({
      version: 3,
      accessScope: "lan",
      channels: {
        chat: { enabled: true, exposure: "lan", config: { CHAT_INBOUND_TOKEN: "${MISSING_CHAT_TOKEN}", CHANNEL_CHAT_SECRET: "" } },
        discord: { enabled: true, exposure: "lan", config: { DISCORD_BOT_TOKEN: "", DISCORD_PUBLIC_KEY: "", CHANNEL_DISCORD_SECRET: "" } },
        voice: { enabled: true, exposure: "lan", config: { CHANNEL_VOICE_SECRET: "" } },
        telegram: { enabled: true, exposure: "lan", config: { TELEGRAM_BOT_TOKEN: "", TELEGRAM_WEBHOOK_SECRET: "", CHANNEL_TELEGRAM_SECRET: "" } },
      },
      services: {},
      automations: [],
    }), "utf8");
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

    // Caddy JSON contains the channel route
    const caddyJson = readFileSync(join(dir, "caddy.json"), "utf8");
    expect(caddyJson).toContain("/channels/slack*");
    expect(caddyJson).toContain("channel-slack:8500");

    // Channels env contains the config values
    const channelsEnv = readFileSync(join(dir, "channel-slack", ".env"), "utf8");
    expect(channelsEnv).toContain("SLACK_BOT_TOKEN=test-token");
    expect(channelsEnv).toContain("SLACK_SIGNING_SECRET=test-secret");
  });

  it("manages config for custom channels independently from built-in channels", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    const spec = manager.getSpec();
    spec.channels["webhook-relay"] = {
      enabled: true,
      exposure: "lan",
      image: "webhook-relay:latest",
      containerPort: 7000,
      config: { RELAY_TARGET: "https://target.example.com", AUTH_HEADER: "Bearer xyz" },
    };
    manager.setSpec(spec);

    const config = manager.getChannelConfig("webhook-relay");
    expect(config.RELAY_TARGET).toBe("https://target.example.com");
    expect(config.AUTH_HEADER).toBe("Bearer xyz");

    manager.setChannelConfig("webhook-relay", {
      RELAY_TARGET: "https://new-target.example.com",
      AUTH_HEADER: "Bearer new-token",
      NEW_KEY: "added-value",
    });

    const updatedConfig = manager.getChannelConfig("webhook-relay");
    expect(updatedConfig.RELAY_TARGET).toBe("https://new-target.example.com");
    expect(updatedConfig.NEW_KEY).toBe("added-value");

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

    // Caddy JSON reflects the change (host guard should have 127.0.0.0/8)
    const caddyJson = readFileSync(join(dir, "caddy.json"), "utf8");
    expect(caddyJson).toContain("127.0.0.0/8");

    // Compose reflects loopback binding
    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
    expect(compose).toContain("127.0.0.1:3000:3000");

    // Change to public (no guard)
    manager.setChannelAccess("my-api", "public");
    const publicJson = readFileSync(join(dir, "caddy.json"), "utf8");
    const config = JSON.parse(publicJson);
    const routes = config.apps.http.servers.main.routes;
    const apiRoute = routes.find((r: Record<string, unknown>) =>
      Array.isArray(r.match) && r.match.some((m: Record<string, unknown>) =>
        Array.isArray(m.path) && (m.path as string[]).includes("/channels/my-api*")
      )
    );
    expect(apiRoute).toBeDefined();
    // Public channel should not have IP guard in its subroute
    const subroute = apiRoute.handle[0];
    const hasGuard = subroute.routes.some((r: Record<string, unknown>) =>
      Array.isArray(r.handle) && (r.handle as Array<Record<string, unknown>>).some((h: Record<string, unknown>) => h.handler === "static_response")
    );
    expect(hasGuard).toBe(false);
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

    const enabled = manager.enabledChannelServiceNames();
    expect(enabled).toContain("channel-chat");
    expect(enabled).toContain("channel-slack");
    expect(enabled).not.toContain("channel-matrix");
  });

  it("caddy.json updates when custom channel is disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    const spec = manager.getSpec();
    spec.channels["temp-svc"] = {
      enabled: true, exposure: "lan",
      image: "temp:latest", containerPort: 7777, config: {},
    };
    manager.setSpec(spec);
    const caddyBefore = readFileSync(join(dir, "caddy.json"), "utf8");
    expect(caddyBefore).toContain("/channels/temp-svc*");

    const updated = manager.getSpec();
    updated.channels["temp-svc"].enabled = false;
    manager.setSpec(updated);
    const caddyAfter = readFileSync(join(dir, "caddy.json"), "utf8");
    expect(caddyAfter).not.toContain("/channels/temp-svc*");
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

    const updated = manager.getSpec();
    delete updated.channels["ephemeral"];
    manager.setSpec(updated);

    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("channel-ephemeral:");
    const caddyJson = readFileSync(join(dir, "caddy.json"), "utf8");
    expect(caddyJson).not.toContain("channel-ephemeral");
  });

  it("custom channel secrets are validated by validateReferencedSecrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    writeFileSync(join(dir, "secrets.env"), "KNOWN_SECRET=value\n", "utf8");
    writeFileSync(join(dir, "openpalm.yaml"), yamlStringify({
      version: 3,
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
      services: {},
      automations: [],
    }), "utf8");

    const manager = createManager(dir);
    const errors = manager.validateReferencedSecrets();
    expect(errors).toContain("missing_secret_reference_my-svc_BAD_REF_UNKNOWN_SECRET");
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
    expect(compose).toContain("9101:9100");

    // Verify Caddy JSON: slack gets path-based route, jira gets domain-based route
    const caddyJson = readFileSync(join(dir, "caddy.json"), "utf8");
    expect(caddyJson).toContain("/channels/slack*");
    expect(caddyJson).toContain("jira.example.com");

    // Verify channels env has resolved secrets
    const slackEnv = readFileSync(join(dir, "channel-slack", ".env"), "utf8");
    const jiraEnv = readFileSync(join(dir, "channel-jira-webhook", ".env"), "utf8");
    expect(slackEnv).toContain("SLACK_BOT_TOKEN=xoxb-slack");
    expect(slackEnv).toContain("SLACK_CHANNEL_ID=C12345");
    expect(jiraEnv).toContain("JIRA_API_KEY=jira-key-123");
    expect(jiraEnv).toContain("JIRA_PROJECT=PROJ");
  });

  it("renders community channels and services from stack spec yaml into artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-community-yaml-"));
    writeFileSync(join(dir, "secrets.env"), "COMMUNITY_SECRET=abc\n", "utf8");
    writeFileSync(join(dir, "openpalm.yaml"), yamlStringify({
      version: 3,
      accessScope: "lan",
      channels: {
        "community/slack adapter": {
          enabled: true,
          exposure: "public",
          image: "ghcr.io/community/slack:latest",
          containerPort: 8210,
          rewritePath: "/slack/events",
          sharedSecretEnv: "CHANNEL_COMMUNITY_SLACK_SECRET",
          config: {
            CHANNEL_COMMUNITY_SLACK_SECRET: "${COMMUNITY_SECRET}",
            "x.extra-key": "on",
          },
        },
      },
      services: {
        "jobs worker@nightly": {
          enabled: true,
          image: "ghcr.io/community/jobs:latest",
          containerPort: 9010,
          config: { "worker.mode": "nightly" },
        },
      },
      automations: [],
    }), "utf8");

    const manager = createManager(dir);
    const rendered = manager.renderArtifacts();

    expect(rendered.composeFile).toContain("channel-community-slack-adapter:");
    expect(rendered.composeFile).toContain("service-jobs-worker-nightly:");
    expect(rendered.caddyJson).toContain("/channels/community/slack adapter*");
    expect(readFileSync(join(dir, "channel-community-slack-adapter", ".env"), "utf8")).toContain("CHANNEL_COMMUNITY_SLACK_SECRET=abc");
    expect(readFileSync(join(dir, "service-jobs-worker-nightly", ".env"), "utf8")).toContain("worker.mode=nightly");
  });

  it("lists stack catalog items for channels and services", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-catalog-"));
    const manager = createManager(dir);
    const spec = manager.getSpec();
    spec.services["jobs"] = {
      enabled: false,
      image: "ghcr.io/community/jobs:latest",
      containerPort: 9001,
      description: "Background worker",
      config: { JOBS_MODE: "daily" },
    };
    manager.setSpec(spec);

    const items = manager.listStackCatalogItems();
    const chat = items.find((item) => item.type === "channel" && item.name === "chat");
    const jobs = items.find((item) => item.type === "service" && item.name === "jobs");

    expect(chat).toBeDefined();
    expect(chat?.fields.some((field) => field.key === "CHAT_INBOUND_TOKEN")).toBe(true);
    expect(jobs).toBeDefined();
    expect(jobs?.description).toBe("Background worker");
    expect(jobs?.fields).toEqual([{ key: "JOBS_MODE", required: false }]);
  });

  it("mutates stack catalog items for install/uninstall/configure actions", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-catalog-mutate-"));
    const manager = createManager(dir);
    const spec = manager.getSpec();
    spec.services["jobs"] = {
      enabled: false,
      image: "ghcr.io/community/jobs:latest",
      containerPort: 9001,
      config: { JOBS_MODE: "daily" },
    };
    manager.setSpec(spec);

    manager.mutateStackCatalogItem({ action: "install", type: "service", name: "jobs" });
    expect(manager.getSpec().services.jobs.enabled).toBe(true);

    manager.upsertSecret("JOBS_SECRET", "s3cret-value");
    manager.mutateStackCatalogItem({
      action: "configure",
      type: "service",
      name: "jobs",
      config: { JOBS_MODE: "${JOBS_SECRET}" },
    });
    expect(manager.getSpec().services.jobs.config.JOBS_MODE).toBe("${JOBS_SECRET}");

    manager.mutateStackCatalogItem({ action: "uninstall", type: "service", name: "jobs" });
    expect(manager.getSpec().services.jobs.enabled).toBe(false);
  });

  it("includes discoverable template items from community snippets", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-catalog-templates-"));
    const manager = createManager(dir);
    const items = manager.listStackCatalogItems([
      {
        kind: "service",
        name: "Ollama",
        description: "Local inference service",
        image: "ollama/ollama:latest",
        containerPort: 11434,
        supportsMultipleInstances: true,
        env: [{ name: "OLLAMA_HOST", required: false, default: "127.0.0.1:11434" }],
        trust: "curated",
        sourceId: "openpalm-community",
        sourceName: "OpenPalm Community",
      },
    ]);

    const ollamaTemplate = items.find((item) => item.entryKind === "template" && item.type === "service" && item.name === "Ollama");
    expect(ollamaTemplate).toBeDefined();
    expect(ollamaTemplate?.installed).toBe(false);
    expect(ollamaTemplate?.supportsMultipleInstances).toBe(true);
    expect(ollamaTemplate?.fields[0].defaultValue).toBe("127.0.0.1:11434");
  });

  it("adds multiple instances for templates that support multiple instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-catalog-multi-instance-"));
    const manager = createManager(dir);

    manager.mutateStackCatalogItem({
      action: "add_instance",
      type: "service",
      name: "Ollama",
      templateName: "Ollama",
      supportsMultipleInstances: true,
      displayName: "Ollama",
      image: "ollama/ollama:latest",
      containerPort: 11434,
      fields: [{ key: "OLLAMA_HOST", required: false, defaultValue: "127.0.0.1:11434" }],
    });
    manager.mutateStackCatalogItem({
      action: "add_instance",
      type: "service",
      name: "Ollama",
      templateName: "Ollama",
      supportsMultipleInstances: true,
      displayName: "Ollama",
      image: "ollama/ollama:latest",
      containerPort: 11434,
      fields: [{ key: "OLLAMA_HOST", required: false, defaultValue: "127.0.0.1:11434" }],
    });

    const spec = manager.getSpec();
    expect(spec.services.ollama).toBeDefined();
    expect(spec.services["ollama-2"]).toBeDefined();
    expect(spec.services["ollama-2"].config.OLLAMA_HOST).toBe("127.0.0.1:11434");
  });

  it("adds multiple channel instances for templates that support multiple instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-catalog-channel-multi-instance-"));
    const manager = createManager(dir);

    manager.mutateStackCatalogItem({
      action: "add_instance",
      type: "channel",
      name: "Slack",
      templateName: "Slack",
      supportsMultipleInstances: true,
      displayName: "Slack",
      image: "openpalm/channel-slack:latest",
      containerPort: 8185,
      rewritePath: "/slack/webhook",
      fields: [
        { key: "SLACK_BOT_TOKEN", required: true, defaultValue: "" },
        { key: "SLACK_SIGNING_SECRET", required: true, defaultValue: "" },
      ],
    });
    manager.mutateStackCatalogItem({
      action: "add_instance",
      type: "channel",
      name: "Slack",
      templateName: "Slack",
      supportsMultipleInstances: true,
      displayName: "Slack",
      image: "openpalm/channel-slack:latest",
      containerPort: 8185,
      rewritePath: "/slack/webhook",
      fields: [
        { key: "SLACK_BOT_TOKEN", required: true, defaultValue: "" },
        { key: "SLACK_SIGNING_SECRET", required: true, defaultValue: "" },
      ],
    });

    const spec = manager.getSpec();
    expect(spec.channels.slack).toBeDefined();
    expect(spec.channels["slack-2"]).toBeDefined();
    expect(spec.channels["slack-2"].template).toBe("Slack");
  });

  it("rejects duplicate instances when template does not support multiple instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-catalog-single-instance-"));
    const manager = createManager(dir);

    manager.mutateStackCatalogItem({
      action: "add_instance",
      type: "service",
      name: "SingleService",
      templateName: "SingleService",
      supportsMultipleInstances: false,
      displayName: "SingleService",
      image: "ghcr.io/example/single:latest",
      containerPort: 9200,
      fields: [],
    });

    expect(() =>
      manager.mutateStackCatalogItem({
        action: "add_instance",
        type: "service",
        name: "SingleService",
        templateName: "SingleService",
        supportsMultipleInstances: false,
        displayName: "SingleService",
        image: "ghcr.io/example/single:latest",
        containerPort: 9200,
        fields: [],
      })
    ).toThrow("multiple_instances_not_supported_for_service_template_SingleService");
  });

  it("hides non-multi templates when a matching enabled instance is running", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-catalog-running-filter-"));
    const manager = createManager(dir);
    const spec = manager.getSpec();
    spec.services["single-service"] = {
      enabled: true,
      template: "SingleService",
      supportsMultipleInstances: false,
      image: "ghcr.io/example/single:latest",
      containerPort: 9200,
      config: {},
    };
    manager.setSpec(spec);

    const items = manager.listStackCatalogItems([
      {
        kind: "service",
        name: "SingleService",
        description: "single instance template",
        image: "ghcr.io/example/single:latest",
        containerPort: 9200,
        supportsMultipleInstances: false,
        env: [],
        trust: "community",
        sourceId: "github:demo/single",
        sourceName: "GitHub",
      },
    ]);

    expect(items.some((item) => item.id === "template:service:SingleService")).toBe(false);
  });

  it("keeps non-multi templates visible when matching instance exists but is disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-catalog-disabled-filter-"));
    const manager = createManager(dir);
    const spec = manager.getSpec();
    spec.services["single-service"] = {
      enabled: false,
      template: "SingleService",
      supportsMultipleInstances: false,
      image: "ghcr.io/example/single:latest",
      containerPort: 9200,
      config: {},
    };
    manager.setSpec(spec);

    const items = manager.listStackCatalogItems([
      {
        kind: "service",
        name: "SingleService",
        description: "single instance template",
        image: "ghcr.io/example/single:latest",
        containerPort: 9200,
        supportsMultipleInstances: false,
        env: [],
        trust: "community",
        sourceId: "github:demo/single",
        sourceName: "GitHub",
      },
    ]);

    expect(items.some((item) => item.id === "template:service:SingleService")).toBe(true);
  });

});
