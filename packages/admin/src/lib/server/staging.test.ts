/**
 * Tests for the staged runtime contract.
 *
 * Verifies that:
 * 1. Channel .caddy files are staged split into public/ and lan/ dirs
 * 2. Malformed .caddy files are skipped with audit entry
 * 3. Channel .yml files are staged to STATE_HOME/artifacts/channels/
 * 4. Compose file list uses staged STATE_HOME paths
 * 5. Secrets.env is staged to STATE_HOME/artifacts/
 * 6. Runtime validation checks staged files, not CONFIG_HOME
 * 7. Startup auto-apply is idempotent
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  readdirSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Import real staging functions from @openpalm/lib ────────────────────
import type { ControlPlaneState } from "@openpalm/lib";
import {
  discoverChannels,
  isValidChannel,
  discoverStagedChannelYmls,
  stageChannelCaddyfiles,
  stageChannelYmlFiles,
  stageSecretsEnv,
  stageAutomationFiles,
  parseAutomationYaml,
} from "@openpalm/lib";

// ── Test helpers — create isolated temp directories ────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a minimal ControlPlaneState for staging tests. */
function makeState(configDir: string, stateDir: string, dataDir?: string): ControlPlaneState {
  return {
    adminToken: "test-token",
    setupToken: "",
    stateDir,
    configDir,
    dataDir: dataDir ?? makeTempDir(),
    services: {},
    artifacts: { compose: "", caddyfile: "" },
    artifactMeta: [],
    audit: [],
    channelSecrets: {},
  };
}

function seedConfigChannels(
  configDir: string,
  channels: { name: string; yml: string; caddy?: string }[]
): void {
  const channelsDir = join(configDir, "channels");
  mkdirSync(channelsDir, { recursive: true });
  for (const ch of channels) {
    writeFileSync(join(channelsDir, `${ch.name}.yml`), ch.yml);
    if (ch.caddy) {
      writeFileSync(join(channelsDir, `${ch.name}.caddy`), ch.caddy);
    }
  }
}

function seedSecretsEnv(configDir: string, content: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "secrets.env"), content);
}

// ── Tests ─────────────────────────────────────────────────────────────

let configDir: string;
let stateDir: string;

beforeEach(() => {
  configDir = makeTempDir();
  stateDir = makeTempDir();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe("Caddy staging split", () => {
  test("LAN-only channel (no explicit access) stages to lan/", () => {
    seedConfigChannels(configDir, [
      {
        name: "chat",
        yml: "services:\n  channel-chat:\n    image: chat:latest\n",
        caddy: "handle_path /chat/* {\n\treverse_proxy channel-chat:8080\n}\n"
      }
    ]);

    const state = makeState(configDir, stateDir);
    stageChannelCaddyfiles(state);

    const lanDir = join(stateDir, "artifacts", "channels", "lan");
    expect(existsSync(join(lanDir, "chat.caddy"))).toBe(true);
    const content = readFileSync(join(lanDir, "chat.caddy"), "utf-8");
    expect(content).toContain("import lan_only");
  });

  test("public_access channel stages to public/", () => {
    seedConfigChannels(configDir, [
      {
        name: "web",
        yml: "services:\n  channel-web:\n    image: web:latest\n",
        caddy: "handle_path /web/* {\n\timport public_access\n\treverse_proxy channel-web:8080\n}\n"
      }
    ]);

    const state = makeState(configDir, stateDir);
    stageChannelCaddyfiles(state);

    const publicDir = join(stateDir, "artifacts", "channels", "public");
    expect(existsSync(join(publicDir, "web.caddy"))).toBe(true);
  });

  test("channel with explicit lan_only stages to lan/ unchanged", () => {
    const caddyContent = "handle_path /api/* {\n\timport lan_only\n\treverse_proxy channel-api:8080\n}\n";
    seedConfigChannels(configDir, [
      {
        name: "api",
        yml: "services:\n  channel-api:\n    image: api:latest\n",
        caddy: caddyContent
      }
    ]);

    const state = makeState(configDir, stateDir);
    stageChannelCaddyfiles(state);

    const lanDir = join(stateDir, "artifacts", "channels", "lan");
    expect(existsSync(join(lanDir, "api.caddy"))).toBe(true);
    const content = readFileSync(join(lanDir, "api.caddy"), "utf-8");
    expect(content).toBe(caddyContent);
  });
});

describe("Malformed .caddy skip", () => {
  test("unstageable caddy emits channels.route.skip audit entry", () => {
    seedConfigChannels(configDir, [
      {
        name: "broken",
        yml: "services:\n  channel-broken:\n    image: broken:latest\n",
        caddy: "# This has no handle/route block\nsome_invalid_caddy_content\n"
      }
    ]);

    const state = makeState(configDir, stateDir);
    stageChannelCaddyfiles(state);

    // Audit entry is appended to state.audit by the real stageChannelCaddyfiles
    expect(state.audit.length).toBe(1);
    expect(state.audit[0].action).toBe("channels.route.skip");
    expect(state.audit[0].args.channel).toBe("broken");
    expect(state.audit[0].ok).toBe(false);

    // File should NOT be staged
    expect(existsSync(join(stateDir, "artifacts", "channels", "lan", "broken.caddy"))).toBe(false);
    expect(existsSync(join(stateDir, "artifacts", "channels", "public", "broken.caddy"))).toBe(false);
  });
});

describe("Channel .yml staging", () => {
  test("yml files are staged to STATE_HOME/artifacts/channels/", () => {
    const ymlContent = "services:\n  channel-chat:\n    image: chat:latest\n";
    seedConfigChannels(configDir, [{ name: "chat", yml: ymlContent }]);

    const state = makeState(configDir, stateDir);
    stageChannelYmlFiles(state);

    const stagedPath = join(stateDir, "artifacts", "channels", "chat.yml");
    expect(existsSync(stagedPath)).toBe(true);
    expect(readFileSync(stagedPath, "utf-8")).toBe(ymlContent);
  });

  test("multiple channels are all staged", () => {
    seedConfigChannels(configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n" },
      { name: "discord", yml: "services:\n  channel-discord:\n    image: discord:latest\n" }
    ]);

    const state = makeState(configDir, stateDir);
    stageChannelYmlFiles(state);

    expect(existsSync(join(stateDir, "artifacts", "channels", "chat.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "artifacts", "channels", "discord.yml"))).toBe(true);
  });
});

describe("Stale .yml cleanup", () => {
  test("removed channels are cleaned from staged dir on re-apply", () => {
    // First: stage two channels
    seedConfigChannels(configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n" },
      { name: "discord", yml: "services:\n  channel-discord:\n    image: discord:latest\n" }
    ]);
    const state = makeState(configDir, stateDir);
    stageChannelYmlFiles(state);
    expect(existsSync(join(stateDir, "artifacts", "channels", "chat.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "artifacts", "channels", "discord.yml"))).toBe(true);

    // Remove discord from config
    rmSync(join(configDir, "channels", "discord.yml"));

    // Re-stage
    stageChannelYmlFiles(state);

    // chat should still exist, discord should be gone
    expect(existsSync(join(stateDir, "artifacts", "channels", "chat.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "artifacts", "channels", "discord.yml"))).toBe(false);
  });
});

describe("Compose file list uses staged paths", () => {
  test("buildComposeFileList returns STATE_HOME paths", () => {
    const ymlContent = "services:\n  channel-chat:\n    image: chat:latest\n";
    seedConfigChannels(configDir, [{ name: "chat", yml: ymlContent }]);
    const state = makeState(configDir, stateDir);
    stageChannelYmlFiles(state);

    const files = discoverStagedChannelYmls(stateDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain(stateDir);
    expect(files[0]).not.toContain(configDir);
    expect(files[0]).toMatch(/chat\.yml$/);
  });
});

describe("Secrets.env staging", () => {
  test("secrets.env is staged from CONFIG to STATE", () => {
    const secretsContent = "ADMIN_TOKEN=test-token\n";
    seedSecretsEnv(configDir, secretsContent);

    const state = makeState(configDir, stateDir);
    stageSecretsEnv(state);

    const stagedPath = join(stateDir, "artifacts", "secrets.env");
    expect(existsSync(stagedPath)).toBe(true);
    expect(readFileSync(stagedPath, "utf-8")).toBe(secretsContent);
  });

  test("missing secrets.env stages an empty file (no error)", () => {
    const state = makeState(configDir, stateDir);
    stageSecretsEnv(state);

    // Production stageSecretsEnv always writes — empty content when source is absent
    const stagedPath = join(stateDir, "artifacts", "secrets.env");
    expect(existsSync(stagedPath)).toBe(true);
    expect(readFileSync(stagedPath, "utf-8")).toBe("");
  });
});

describe("Runtime validation uses staged files", () => {
  test("isValidChannel checks STATE_HOME for staged channels", () => {
    const ymlContent = "services:\n  channel-custom:\n    image: custom:latest\n";
    seedConfigChannels(configDir, [{ name: "custom", yml: ymlContent }]);
    const state = makeState(configDir, stateDir);
    stageChannelYmlFiles(state);

    // Should find it in STATE_HOME
    expect(isValidChannel("custom", stateDir)).toBe(true);

    // Should NOT find an unstaged channel
    expect(isValidChannel("nonexistent", stateDir)).toBe(false);
  });

  test("source-only channel (not staged) is not valid at runtime", () => {
    seedConfigChannels(configDir, [
      { name: "unstaged", yml: "services:\n  channel-unstaged:\n    image: unstaged:latest\n" }
    ]);

    // NOT staged to stateDir — so runtime validation should reject
    expect(isValidChannel("unstaged", stateDir)).toBe(false);
  });
});

describe("Staging idempotence", () => {
  test("running staging twice produces identical results", () => {
    const ymlContent = "services:\n  channel-chat:\n    image: chat:latest\n";
    const caddyContent = "handle_path /chat/* {\n\treverse_proxy channel-chat:8080\n}\n";
    const secretsContent = "ADMIN_TOKEN=test\n";

    seedConfigChannels(configDir, [{ name: "chat", yml: ymlContent, caddy: caddyContent }]);
    seedSecretsEnv(configDir, secretsContent);

    const state = makeState(configDir, stateDir);

    // Apply order matches persistArtifacts: secrets → yml → caddy
    function applyAll(): void {
      stageSecretsEnv(state);
      stageChannelYmlFiles(state);
      stageChannelCaddyfiles(state);
    }

    // First apply
    applyAll();

    const yml1 = readFileSync(join(stateDir, "artifacts", "channels", "chat.yml"), "utf-8");
    const caddy1 = readFileSync(join(stateDir, "artifacts", "channels", "lan", "chat.caddy"), "utf-8");
    const secrets1 = readFileSync(join(stateDir, "artifacts", "secrets.env"), "utf-8");

    // Second apply (idempotent)
    applyAll();

    const yml2 = readFileSync(join(stateDir, "artifacts", "channels", "chat.yml"), "utf-8");
    const caddy2 = readFileSync(join(stateDir, "artifacts", "channels", "lan", "chat.caddy"), "utf-8");
    const secrets2 = readFileSync(join(stateDir, "artifacts", "secrets.env"), "utf-8");

    expect(yml1).toBe(yml2);
    expect(caddy1).toBe(caddy2);
    expect(secrets1).toBe(secrets2);
  });
});

// ── Automation staging (YAML format) ──────────────────────────────────

// Valid YAML automation content for tests
const VALID_API_YAML = 'schedule: daily\naction:\n  type: api\n  path: /health\n';
const VALID_HTTP_YAML = 'schedule: daily\naction:\n  type: http\n  method: POST\n  url: http://example.com/hook\n';
const VALID_SHELL_YAML = 'schedule: weekly\naction:\n  type: shell\n  command:\n    - /bin/echo\n    - hello\n';

function seedAutomationFiles(
  dir: string,
  files: { name: string; content: string }[]
): void {
  const automationsDir = join(dir, "automations");
  mkdirSync(automationsDir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(automationsDir, f.name), f.content);
  }
}

let dataDir: string;

describe("Automation file staging", () => {
  beforeEach(() => {
    dataDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("user automation files are staged to STATE_HOME/automations/", () => {
    seedAutomationFiles(configDir, [{ name: "backup.yml", content: VALID_API_YAML }]);

    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);

    const stagedPath = join(stateDir, "automations", "backup.yml");
    expect(existsSync(stagedPath)).toBe(true);
    expect(readFileSync(stagedPath, "utf-8")).toBe(VALID_API_YAML);
  });

  test("system automation files are staged from DATA_HOME/automations/", () => {
    seedAutomationFiles(dataDir, [{ name: "healthcheck.yml", content: VALID_API_YAML }]);

    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);

    const stagedPath = join(stateDir, "automations", "healthcheck.yml");
    expect(existsSync(stagedPath)).toBe(true);
  });

  test("user automation files override system files with the same name", () => {
    const systemContent = 'schedule: daily\naction:\n  type: api\n  path: /old\n';
    const userContent = 'schedule: daily\naction:\n  type: api\n  path: /new\n';

    seedAutomationFiles(dataDir, [{ name: "backup.yml", content: systemContent }]);
    seedAutomationFiles(configDir, [{ name: "backup.yml", content: userContent }]);

    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);

    const stagedPath = join(stateDir, "automations", "backup.yml");
    expect(readFileSync(stagedPath, "utf-8")).toBe(userContent);
  });

  test("both system and user automation files are staged together", () => {
    seedAutomationFiles(dataDir, [
      { name: "healthcheck.yml", content: VALID_API_YAML }
    ]);
    seedAutomationFiles(configDir, [
      { name: "backup.yml", content: VALID_HTTP_YAML }
    ]);

    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);

    expect(existsSync(join(stateDir, "automations", "healthcheck.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "automations", "backup.yml"))).toBe(true);
  });

  test("all three action types can be staged", () => {
    seedAutomationFiles(configDir, [
      { name: "api-job.yml", content: VALID_API_YAML },
      { name: "http-job.yml", content: VALID_HTTP_YAML },
      { name: "shell-job.yml", content: VALID_SHELL_YAML }
    ]);

    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);

    expect(existsSync(join(stateDir, "automations", "api-job.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "automations", "http-job.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "automations", "shell-job.yml"))).toBe(true);
  });

  test("invalid automation filenames are ignored", () => {
    const automationsDir = join(configDir, "automations");
    mkdirSync(automationsDir, { recursive: true });
    // Invalid: starts with hyphen
    writeFileSync(join(automationsDir, "-bad.yml"), VALID_API_YAML);
    // Valid
    writeFileSync(join(automationsDir, "good.yml"), VALID_API_YAML);

    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);

    expect(existsSync(join(stateDir, "automations", "good.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "automations", "-bad.yml"))).toBe(false);
  });

  test("non-.yml files are ignored", () => {
    const automationsDir = join(configDir, "automations");
    mkdirSync(automationsDir, { recursive: true });
    // Old crontab-style file without .yml extension
    writeFileSync(join(automationsDir, "old-crontab"), "0 2 * * * node /work/task.sh\n");
    // Valid YAML automation
    writeFileSync(join(automationsDir, "good.yml"), VALID_API_YAML);

    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);

    expect(existsSync(join(stateDir, "automations", "good.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "automations", "old-crontab"))).toBe(false);
  });

  test("invalid YAML content is not staged", () => {
    seedAutomationFiles(configDir, [
      { name: "bad-yaml.yml", content: "schedule: [invalid: yaml: :::" }
    ]);

    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);

    expect(existsSync(join(stateDir, "automations", "bad-yaml.yml"))).toBe(false);
  });

  test("YAML missing required fields is not staged", () => {
    // Missing action
    seedAutomationFiles(configDir, [
      { name: "no-action.yml", content: "schedule: daily\n" }
    ]);

    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);

    expect(existsSync(join(stateDir, "automations", "no-action.yml"))).toBe(false);
  });

  test("YAML with invalid action type is not staged", () => {
    seedAutomationFiles(configDir, [
      { name: "bad-type.yml", content: 'schedule: daily\naction:\n  type: webhook\n  url: http://example.com\n' }
    ]);

    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);

    expect(existsSync(join(stateDir, "automations", "bad-type.yml"))).toBe(false);
  });

  test("stale automation files are cleaned on re-apply", () => {
    seedAutomationFiles(configDir, [
      { name: "backup.yml", content: VALID_API_YAML },
      { name: "cleanup.yml", content: VALID_SHELL_YAML }
    ]);
    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);
    expect(existsSync(join(stateDir, "automations", "backup.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "automations", "cleanup.yml"))).toBe(true);

    // Remove cleanup from config
    rmSync(join(configDir, "automations", "cleanup.yml"));
    stageAutomationFiles(state);

    expect(existsSync(join(stateDir, "automations", "backup.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "automations", "cleanup.yml"))).toBe(false);
  });

  test("empty automation directories produce no staged files", () => {
    mkdirSync(join(configDir, "automations"), { recursive: true });
    mkdirSync(join(dataDir, "automations"), { recursive: true });

    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);

    const automationsDir = join(stateDir, "automations");
    const files = existsSync(automationsDir)
      ? readdirSync(automationsDir).filter((f) => !f.startsWith("."))
      : [];
    expect(files.length).toBe(0);
  });

  test("staging is idempotent", () => {
    seedAutomationFiles(configDir, [
      { name: "backup.yml", content: VALID_API_YAML }
    ]);

    const state = makeState(configDir, stateDir, dataDir);
    stageAutomationFiles(state);
    const first = readFileSync(join(stateDir, "automations", "backup.yml"), "utf-8");

    stageAutomationFiles(state);
    const second = readFileSync(join(stateDir, "automations", "backup.yml"), "utf-8");

    expect(first).toBe(second);
  });
});
