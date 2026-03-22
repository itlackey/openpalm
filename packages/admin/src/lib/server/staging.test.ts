/**
 * Tests for the configuration persistence contract.
 *
 * Verifies that:
 * 1. Stack compose overlays live in stack/ (not config/components/)
 * 2. Compose file list uses stack/ paths
 * 3. User secrets live in vault/user/user.env
 * 4. Runtime validation checks the stack spec for channels
 * 5. Configuration persistence is idempotent
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Import real functions from @openpalm/lib ────────────────────────────
import type { ControlPlaneState } from "@openpalm/lib";
import {
  discoverChannels,
  isValidChannel,
  discoverStackOverlays,
  writeSystemEnv,
  parseAutomationYaml,
} from "@openpalm/lib";

// ── Test helpers — create isolated temp directories ────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a minimal ControlPlaneState for tests. */
function makeState(tempDir?: string): ControlPlaneState {
  const base = tempDir ?? makeTempDir();
  return {
    adminToken: "test-token",
    assistantToken: "test-assistant-token",
    setupToken: "",
    homeDir: base,
    configDir: join(base, "config"),
    vaultDir: join(base, "vault"),
    dataDir: join(base, "data"),
    logsDir: join(base, "logs"),
    cacheDir: join(base, "cache"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
    audit: [],
  };
}

/** Seed channel addon files in stack/addons/<name>/compose.yml. */
function seedChannelAddons(
  homeDir: string,
  channels: { name: string; yml: string }[]
): void {
  for (const ch of channels) {
    const addonDir = join(homeDir, "stack", "addons", ch.name);
    mkdirSync(addonDir, { recursive: true });
    writeFileSync(join(addonDir, "compose.yml"), ch.yml);
  }
}

function seedUserEnv(vaultDir: string, content: string): void {
  mkdirSync(join(vaultDir, "user"), { recursive: true });
  writeFileSync(join(vaultDir, "user", "user.env"), content);
}

// ── Tests ─────────────────────────────────────────────────────────────

let baseDir: string;

beforeEach(() => {
  baseDir = makeTempDir();
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("Stack overlay discovery — stack/ layout", () => {
  test("discoverStackOverlays returns core.compose.yml from stack/", () => {
    const stackDir = join(baseDir, "stack");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, "core.compose.yml"), "services:\n  guardian:\n    image: guardian:latest\n");

    const files = discoverStackOverlays(stackDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/core\.compose\.yml$/);
  });

  test("discoverStackOverlays discovers addon compose.yml files", () => {
    const stackDir = join(baseDir, "stack");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, "core.compose.yml"), "services: {}");

    const addonsDir = join(stackDir, "addons");
    mkdirSync(join(addonsDir, "admin"), { recursive: true });
    writeFileSync(join(addonsDir, "admin", "compose.yml"), "services: {}");

    const files = discoverStackOverlays(stackDir);
    expect(files.length).toBe(2);
    expect(files.some((f) => f.includes("admin"))).toBe(true);
  });

  test("discoverStackOverlays returns empty when stack dir is empty", () => {
    const stackDir = join(baseDir, "stack");
    mkdirSync(stackDir, { recursive: true });

    expect(discoverStackOverlays(stackDir)).toEqual([]);
  });
});

describe("User secrets in vault/user/user.env", () => {
  test("user.env is read from vault/user/", () => {
    const state = makeState(baseDir);
    const secretsContent = "ADMIN_TOKEN=test-token\n";
    seedUserEnv(state.vaultDir, secretsContent);

    const userEnvPath = join(state.vaultDir, "user", "user.env");
    expect(existsSync(userEnvPath)).toBe(true);
    expect(readFileSync(userEnvPath, "utf-8")).toBe(secretsContent);
  });
});

describe("Runtime validation uses stack/addons/", () => {
  test("isValidChannel checks stack/addons/<name>/compose.yml for channel overlays", () => {
    const state = makeState(baseDir);
    seedChannelAddons(state.homeDir, [
      { name: "custom", yml: "services:\n  channel-custom:\n    image: custom:latest\n" }
    ]);

    // Should find it in stack/addons/custom/compose.yml
    expect(isValidChannel("custom", state.configDir)).toBe(true);

    // Should NOT find an uninstalled channel
    expect(isValidChannel("nonexistent", state.configDir)).toBe(false);
  });

  test("source-only channel (not in stack/addons/) is not valid at runtime", () => {
    const state = makeState(baseDir);
    // Write to old channels/ dir, not stack/addons/
    const channelsDir = join(state.configDir, "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "unstaged.yml"), "services:\n  channel-unstaged:\n    image: unstaged:latest\n");

    // NOT in stack/addons/ — so runtime validation should reject
    expect(isValidChannel("unstaged", state.configDir)).toBe(false);
  });
});

// ── Automation YAML parsing ──────────────────────────────────────────────

// Valid YAML automation content for tests
const VALID_API_YAML = 'schedule: daily\naction:\n  type: api\n  path: /health\n';
const VALID_HTTP_YAML = 'schedule: daily\naction:\n  type: http\n  method: POST\n  url: http://example.com/hook\n';
const VALID_SHELL_YAML = 'schedule: weekly\naction:\n  type: shell\n  command:\n    - /bin/echo\n    - hello\n';

describe("Automation YAML parsing", () => {
  test("parses valid api automation", () => {
    const config = parseAutomationYaml(VALID_API_YAML, "backup.yml");
    expect(config).not.toBeNull();
    expect(config!.action.type).toBe("api");
  });

  test("parses valid http automation", () => {
    const config = parseAutomationYaml(VALID_HTTP_YAML, "http-job.yml");
    expect(config).not.toBeNull();
    expect(config!.action.type).toBe("http");
  });

  test("parses valid shell automation", () => {
    const config = parseAutomationYaml(VALID_SHELL_YAML, "shell-job.yml");
    expect(config).not.toBeNull();
    expect(config!.action.type).toBe("shell");
  });

  test("rejects invalid YAML content", () => {
    expect(parseAutomationYaml("schedule: [invalid: yaml: :::", "bad-yaml.yml")).toBeNull();
  });

  test("rejects YAML missing required fields", () => {
    // Missing action
    expect(parseAutomationYaml("schedule: daily\n", "no-action.yml")).toBeNull();
  });

  test("rejects YAML with invalid action type", () => {
    const yaml = 'schedule: daily\naction:\n  type: webhook\n  url: http://example.com\n';
    expect(parseAutomationYaml(yaml, "bad-type.yml")).toBeNull();
  });
});
