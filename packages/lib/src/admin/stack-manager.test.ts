import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { StackManager } from "./stack-manager.ts";
import { stringifyYamlDocument } from "../shared/yaml.ts";

const yamlStringify = (obj: unknown) => stringifyYamlDocument(obj);

function createManager(dir: string) {
  return new StackManager({
    stateRootPath: dir,
    dataRootPath: join(dir, "data"),
    configRootPath: join(dir, "config"),
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

function parseEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    parsed[key] = value;
  }
  return parsed;
}

describe("stack manager", () => {
  it("caches parsed stack spec between getSpec calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-cache-"));
    try {
      const manager = createManager(dir);

      const first = manager.getSpec();
      const specPath = join(dir, "openpalm.yaml");
      const mutated = { ...first, accessScope: "public" as const };
      writeFileSync(specPath, yamlStringify(mutated), "utf8");

      // getSpec should serve the cached in-memory copy until manager mutates state.
      const second = manager.getSpec();
      expect(second.accessScope).toBe(first.accessScope);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes all generated stack artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    manager.upsertSecret("CHAT_TOKEN_SECRET", "abc");
    manager.upsertSecret("CHAT_SHARED_SECRET", "abc12345678901234567890123456789");
    const spec = manager.getSpec();
    spec.channels.chat.config = {
      CHAT_INBOUND_TOKEN: "${CHAT_TOKEN_SECRET}",
      CHANNEL_CHAT_SECRET: "${CHAT_SHARED_SECRET}",
    };
    manager.setSpec(spec);

    // Caddy JSON is written
    const caddyJson = readFileSync(join(dir, "caddy.json"), "utf8");
    const caddyConfig = JSON.parse(caddyJson);
    expect(caddyConfig.admin.disabled).toBe(true);
    expect(caddyConfig.apps.http.servers.main).toBeDefined();

    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain("assistant:");
    expect(readFileSync(join(dir, "gateway", ".env"), "utf8")).not.toContain("CHANNEL_CHAT_SECRET=abc12345678901234567890123456789");
    expect(readFileSync(join(dir, "channel-chat", ".env"), "utf8")).toContain("CHAT_INBOUND_TOKEN=abc");
    // chat channel env file should exist with proper content
    expect(readFileSync(join(dir, "channel-chat", ".env"), "utf8")).toContain("CHAT_INBOUND_TOKEN=abc");
  });

  it("creates all required directories from scratch when they do not pre-exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-mkdir-test-"));
    const manager = new StackManager({
      stateRootPath: dir,
      dataRootPath: join(dir, "data"),
      configRootPath: join(dir, "config"),
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

  it("writes scoped core .env files in state with the expected key sets", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-core-env-"));
    const manager = createManager(dir);

    manager.upsertSecret("OPENPALM_GATEWAY_HMAC_SECRET", "gateway-hmac");
    manager.upsertSecret("GATEWAY_EXTRA_FLAG", "1");
    manager.upsertSecret("OPENPALM_SMALL_MODEL_API_KEY", "small-model-key");
    manager.upsertSecret("ANTHROPIC_API_KEY", "anthropic-key");
    manager.upsertSecret("OPENAI_BASE_URL", "https://api.openai.example/v1");
    manager.upsertSecret("OPENAI_API_KEY", "openai-key");
    manager.upsertSecret("POSTGRES_DB", "openpalm");
    manager.upsertSecret("POSTGRES_USER", "openpalm-user");
    manager.upsertSecret("POSTGRES_PASSWORD", "postgres-pass");
    manager.upsertSecret("OPENPALM_PROFILE_NAME", "OpenPalm Bot");
    manager.upsertSecret("OPENPALM_PROFILE_EMAIL", "bot@openpalm.dev");
    manager.upsertSecret("SHOULD_NOT_BE_ROUTED", "nope");

    manager.renderArtifacts();

    const gatewayEnv = parseEnvFile(readFileSync(join(dir, "gateway", ".env"), "utf8"));
    expect(gatewayEnv.OPENPALM_GATEWAY_HMAC_SECRET).toBe("gateway-hmac");
    expect(gatewayEnv.GATEWAY_EXTRA_FLAG).toBe("1");
    expect(gatewayEnv.OPENPALM_SMALL_MODEL_API_KEY).toBe("small-model-key");
    expect(gatewayEnv.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(gatewayEnv.SHOULD_NOT_BE_ROUTED).toBeUndefined();

    const openmemoryEnv = parseEnvFile(readFileSync(join(dir, "openmemory", ".env"), "utf8"));
    expect(openmemoryEnv.OPENAI_BASE_URL).toBe("https://api.openai.example/v1");
    expect(openmemoryEnv.OPENAI_API_KEY).toBe("openai-key");
    expect(Object.keys(openmemoryEnv).sort()).toEqual(["OPENAI_API_KEY", "OPENAI_BASE_URL"]);

    const postgresEnv = parseEnvFile(readFileSync(join(dir, "postgres", ".env"), "utf8"));
    expect(postgresEnv.POSTGRES_DB).toBe("openpalm");
    expect(postgresEnv.POSTGRES_USER).toBe("openpalm-user");
    expect(postgresEnv.POSTGRES_PASSWORD).toBe("postgres-pass");

    const assistantEnv = parseEnvFile(readFileSync(join(dir, "assistant", ".env"), "utf8"));
    expect(assistantEnv.OPENPALM_SMALL_MODEL_API_KEY).toBe("small-model-key");
    expect(assistantEnv.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(assistantEnv.OPENPALM_PROFILE_NAME).toBe("OpenPalm Bot");
    expect(assistantEnv.OPENPALM_PROFILE_EMAIL).toBe("bot@openpalm.dev");
    expect(assistantEnv.GATEWAY_EXTRA_FLAG).toBeUndefined();

    const qdrantEnvRaw = readFileSync(join(dir, "qdrant", ".env"), "utf8");
    expect(qdrantEnvRaw).toBe("# Generated qdrant env\n");
  });

  it("writes channel and service .env files with resolved and literal values", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-channel-service-env-"));
    const manager = createManager(dir);

    manager.upsertSecret("CHAT_INBOUND_SECRET", "chat-token");
    manager.upsertSecret("SVC_API_KEY_SECRET", "svc-key");

    const spec = manager.getSpec();
    spec.channels.chat.enabled = true;
    spec.channels.chat.config.CHAT_INBOUND_TOKEN = "${CHAT_INBOUND_SECRET}";
    spec.channels.chat.config.CHANNEL_CHAT_SECRET = "literal-chat-secret";
    spec.services["worker"] = {
      enabled: true,
      image: "worker:latest",
      containerPort: 9400,
      config: {
        WORKER_MODE: "nightly",
        API_KEY: "${SVC_API_KEY_SECRET}",
        OPTIONAL_FLAG: "",
      },
    };
    manager.setSpec(spec);

    const chatEnv = parseEnvFile(readFileSync(join(dir, "channel-chat", ".env"), "utf8"));
    expect(chatEnv.CHAT_INBOUND_TOKEN).toBe("chat-token");
    expect(chatEnv.CHANNEL_CHAT_SECRET).toBe("literal-chat-secret");

    const workerEnv = parseEnvFile(readFileSync(join(dir, "service-worker", ".env"), "utf8"));
    expect(workerEnv.WORKER_MODE).toBe("nightly");
    expect(workerEnv.API_KEY).toBe("svc-key");
    expect(workerEnv.OPTIONAL_FLAG).toBe("");
  });

  it("does not write .env files for disabled channels or services even with unresolved secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-disabled-env-"));
    const manager = createManager(dir);

    const spec = manager.getSpec();
    spec.channels["disabled-hook"] = {
      enabled: false,
      exposure: "lan",
      image: "hook:latest",
      containerPort: 7000,
      config: { HOOK_TOKEN: "${MISSING_HOOK_TOKEN}" },
    };
    spec.services["disabled-worker"] = {
      enabled: false,
      image: "worker:latest",
      containerPort: 7100,
      config: { WORKER_TOKEN: "${MISSING_WORKER_TOKEN}" },
    };

    expect(() => manager.setSpec(spec)).not.toThrow();
    expect(existsSync(join(dir, "channel-disabled-hook", ".env"))).toBeFalse();
    expect(existsSync(join(dir, "service-disabled-worker", ".env"))).toBeFalse();
  });

  it("system.env updates when access scope changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);

    const spec = manager.getSpec();
    spec.accessScope = "host";
    manager.setSpec(spec);

    const systemEnv = readFileSync(join(dir, "system.env"), "utf8");
    expect(systemEnv).toContain("OPENPALM_ACCESS_SCOPE=host");
  });

  it("prevents deleting secrets that are referenced by channel config", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);
    manager.upsertSecret("CHAT_TOKEN_SECRET", "x");
    const spec = manager.getSpec();
    spec.channels.chat.config = {
      CHAT_INBOUND_TOKEN: "${CHAT_TOKEN_SECRET}",
      CHANNEL_CHAT_SECRET: "",
    };
    manager.setSpec(spec);
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
      },
      services: {},
    }), "utf8");
    const manager = createManager(dir);

    expect(manager.validateReferencedSecrets()).toContain("missing_secret_reference_chat_CHAT_INBOUND_TOKEN_MISSING_CHAT_TOKEN");
  });

  it("supports host exposure for channels", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-stack-manager-"));
    const manager = createManager(dir);
    const spec = manager.getSpec();
    spec.channels.chat.exposure = "host";
    manager.setSpec(spec);
    expect(manager.getChannelAccess("chat")).toBe("host");
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

  it("updates custom channel config via setSpec and produces correct env files", () => {
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

    const channelsEnv = readFileSync(join(dir, "channel-webhook-relay", ".env"), "utf8");
    expect(channelsEnv).toContain("RELAY_TARGET=https://target.example.com");

    const updated = manager.getSpec();
    updated.channels["webhook-relay"].config = {
      RELAY_TARGET: "https://new-target.example.com",
      AUTH_HEADER: "Bearer new-token",
      NEW_KEY: "added-value",
    };
    manager.setSpec(updated);

    const updatedEnv = readFileSync(join(dir, "channel-webhook-relay", ".env"), "utf8");
    expect(updatedEnv).toContain("RELAY_TARGET=https://new-target.example.com");
    expect(updatedEnv).toContain("NEW_KEY=added-value");
  });

  it("manages exposure levels for custom channels via setSpec", () => {
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
    const hostSpec = manager.getSpec();
    hostSpec.channels["my-api"].exposure = "host";
    manager.setSpec(hostSpec);
    expect(manager.getChannelAccess("my-api")).toBe("host");

    // Caddy JSON reflects the change (host guard should have 127.0.0.0/8)
    const caddyJson = readFileSync(join(dir, "caddy.json"), "utf8");
    expect(caddyJson).toContain("127.0.0.0/8");

    // Compose reflects loopback binding
    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
    expect(compose).toContain("127.0.0.1:3000:3000");

    // Change to public (no guard)
    const publicSpec = manager.getSpec();
    publicSpec.channels["my-api"].exposure = "public";
    manager.setSpec(publicSpec);
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
    expect(names).toContain("slack");
    expect(names).toContain("matrix");
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
    }), "utf8");

    const manager = createManager(dir);
    const rendered = manager.renderArtifacts();

    expect(rendered.composeFile).toContain("channel-community-slack-adapter:");
    expect(rendered.composeFile).toContain("service-jobs-worker-nightly:");
    expect(rendered.caddyJson).toContain("/channels/community/slack adapter*");
    expect(readFileSync(join(dir, "channel-community-slack-adapter", ".env"), "utf8")).toContain("CHANNEL_COMMUNITY_SLACK_SECRET=abc");
    expect(readFileSync(join(dir, "service-jobs-worker-nightly", ".env"), "utf8")).toContain("worker.mode=nightly");
  });

});
