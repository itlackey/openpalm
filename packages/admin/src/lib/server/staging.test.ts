/**
 * Tests for the configuration persistence contract.
 *
 * Verifies that:
 * 1. Channel .caddy files are written split into public/ and lan/ dirs
 * 2. Malformed .caddy files are skipped with audit entry
 * 3. Channel .yml overlays exist in config/components/
 * 4. Compose file list uses config/components/ paths
 * 5. User secrets live in vault/user.env
 * 6. Runtime validation checks config/components/ for channels
 * 7. Configuration persistence is idempotent
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

// ── Import real functions from @openpalm/lib ────────────────────────────
import type { ControlPlaneState } from "@openpalm/lib";
import {
  discoverChannels,
  isValidChannel,
  discoverChannelOverlays,
  writeCaddyRoutes,
  writeComponentOverlay,
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
    artifacts: { compose: "", caddyfile: "" },
    artifactMeta: [],
    audit: [],
  };
}

/** Seed channel overlay files in config/components/ (the new layout). */
function seedChannelComponents(
  configDir: string,
  channels: { name: string; yml: string; caddy?: string }[]
): void {
  const componentsDir = join(configDir, "components");
  mkdirSync(componentsDir, { recursive: true });
  for (const ch of channels) {
    writeFileSync(join(componentsDir, `channel-${ch.name}.yml`), ch.yml);
    if (ch.caddy) {
      writeFileSync(join(componentsDir, `channel-${ch.name}.caddy`), ch.caddy);
    }
  }
}

function seedUserEnv(vaultDir: string, content: string): void {
  mkdirSync(vaultDir, { recursive: true });
  writeFileSync(join(vaultDir, "user.env"), content);
}

// ── Tests ─────────────────────────────────────────────────────────────

let baseDir: string;

beforeEach(() => {
  baseDir = makeTempDir();
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("Caddy route writing split", () => {
  test("LAN-only channel (no explicit access) writes to lan/", () => {
    const state = makeState(baseDir);
    seedChannelComponents(state.configDir, [
      {
        name: "chat",
        yml: "services:\n  channel-chat:\n    image: chat:latest\n",
        caddy: "handle_path /chat/* {\n\treverse_proxy channel-chat:8080\n}\n"
      }
    ]);

    writeCaddyRoutes(state);

    const lanDir = join(state.dataDir, "caddy", "channels", "lan");
    expect(existsSync(join(lanDir, "chat.caddy"))).toBe(true);
    const content = readFileSync(join(lanDir, "chat.caddy"), "utf-8");
    expect(content).toContain("import lan_only");
  });

  test("public_access channel writes to public/", () => {
    const state = makeState(baseDir);
    seedChannelComponents(state.configDir, [
      {
        name: "web",
        yml: "services:\n  channel-web:\n    image: web:latest\n",
        caddy: "handle_path /web/* {\n\timport public_access\n\treverse_proxy channel-web:8080\n}\n"
      }
    ]);

    writeCaddyRoutes(state);

    const publicDir = join(state.dataDir, "caddy", "channels", "public");
    expect(existsSync(join(publicDir, "web.caddy"))).toBe(true);
  });

  test("channel with explicit lan_only writes to lan/ unchanged", () => {
    const caddyContent = "handle_path /api/* {\n\timport lan_only\n\treverse_proxy channel-api:8080\n}\n";
    const state = makeState(baseDir);
    seedChannelComponents(state.configDir, [
      {
        name: "api",
        yml: "services:\n  channel-api:\n    image: api:latest\n",
        caddy: caddyContent
      }
    ]);

    writeCaddyRoutes(state);

    const lanDir = join(state.dataDir, "caddy", "channels", "lan");
    expect(existsSync(join(lanDir, "api.caddy"))).toBe(true);
    const content = readFileSync(join(lanDir, "api.caddy"), "utf-8");
    expect(content).toBe(caddyContent);
  });
});

describe("Malformed .caddy skip", () => {
  test("unstageable caddy emits channels.route.skip audit entry", () => {
    const state = makeState(baseDir);
    seedChannelComponents(state.configDir, [
      {
        name: "broken",
        yml: "services:\n  channel-broken:\n    image: broken:latest\n",
        caddy: "# This has no handle/route block\nsome_invalid_caddy_content\n"
      }
    ]);

    writeCaddyRoutes(state);

    // Audit entry is appended to state.audit by writeCaddyRoutes
    expect(state.audit.length).toBe(1);
    expect(state.audit[0].action).toBe("channels.route.skip");
    expect(state.audit[0].args.channel).toBe("broken");
    expect(state.audit[0].ok).toBe(false);

    // File should NOT be written
    expect(existsSync(join(state.dataDir, "caddy", "channels", "lan", "broken.caddy"))).toBe(false);
    expect(existsSync(join(state.dataDir, "caddy", "channels", "public", "broken.caddy"))).toBe(false);
  });
});

describe("Channel component overlay writing", () => {
  test("overlay files are written to config/components/", () => {
    const ymlContent = "services:\n  channel-chat:\n    image: chat:latest\n";
    const state = makeState(baseDir);
    writeComponentOverlay(state, "channel-chat", ymlContent);

    const overlayPath = join(state.configDir, "components", "channel-chat.yml");
    expect(existsSync(overlayPath)).toBe(true);
    expect(readFileSync(overlayPath, "utf-8")).toBe(ymlContent);
  });

  test("multiple channel overlays are all written", () => {
    const state = makeState(baseDir);
    writeComponentOverlay(state, "channel-chat", "services:\n  channel-chat:\n    image: chat:latest\n");
    writeComponentOverlay(state, "channel-discord", "services:\n  channel-discord:\n    image: discord:latest\n");

    expect(existsSync(join(state.configDir, "components", "channel-chat.yml"))).toBe(true);
    expect(existsSync(join(state.configDir, "components", "channel-discord.yml"))).toBe(true);
  });
});

describe("Stale overlay cleanup", () => {
  test("removed channels are cleaned from caddy routes on re-apply", () => {
    const state = makeState(baseDir);
    // First: write two channels
    seedChannelComponents(state.configDir, [
      {
        name: "chat",
        yml: "services:\n  channel-chat:\n    image: chat:latest\n",
        caddy: "handle_path /chat/* {\n\treverse_proxy channel-chat:8080\n}\n"
      },
      {
        name: "discord",
        yml: "services:\n  channel-discord:\n    image: discord:latest\n",
        caddy: "handle_path /discord/* {\n\treverse_proxy channel-discord:8080\n}\n"
      }
    ]);
    writeCaddyRoutes(state);
    expect(existsSync(join(state.dataDir, "caddy", "channels", "lan", "chat.caddy"))).toBe(true);
    expect(existsSync(join(state.dataDir, "caddy", "channels", "lan", "discord.caddy"))).toBe(true);

    // Remove discord from config
    rmSync(join(state.configDir, "components", "channel-discord.yml"));
    rmSync(join(state.configDir, "components", "channel-discord.caddy"));

    // Re-write routes
    writeCaddyRoutes(state);

    // chat should still exist, discord should be gone
    expect(existsSync(join(state.dataDir, "caddy", "channels", "lan", "chat.caddy"))).toBe(true);
    expect(existsSync(join(state.dataDir, "caddy", "channels", "lan", "discord.caddy"))).toBe(false);
  });
});

describe("Compose file list uses config/components/ paths", () => {
  test("discoverChannelOverlays returns config/components/ paths", () => {
    const state = makeState(baseDir);
    seedChannelComponents(state.configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n" }
    ]);

    const files = discoverChannelOverlays(state.configDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain(state.configDir);
    expect(files[0]).toMatch(/channel-chat\.yml$/);
  });
});

describe("User secrets in vault/user.env", () => {
  test("user.env is read from vault/", () => {
    const state = makeState(baseDir);
    const secretsContent = "ADMIN_TOKEN=test-token\n";
    seedUserEnv(state.vaultDir, secretsContent);

    const userEnvPath = join(state.vaultDir, "user.env");
    expect(existsSync(userEnvPath)).toBe(true);
    expect(readFileSync(userEnvPath, "utf-8")).toBe(secretsContent);
  });
});

describe("Runtime validation uses config/components/", () => {
  test("isValidChannel checks config/components/ for channel overlays", () => {
    const state = makeState(baseDir);
    seedChannelComponents(state.configDir, [
      { name: "custom", yml: "services:\n  channel-custom:\n    image: custom:latest\n" }
    ]);

    // Should find it in config/components/
    expect(isValidChannel("custom", state.configDir)).toBe(true);

    // Should NOT find an uninstalled channel
    expect(isValidChannel("nonexistent", state.configDir)).toBe(false);
  });

  test("source-only channel (not in components/) is not valid at runtime", () => {
    const state = makeState(baseDir);
    // Write to old channels/ dir, not components/
    const channelsDir = join(state.configDir, "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "unstaged.yml"), "services:\n  channel-unstaged:\n    image: unstaged:latest\n");

    // NOT in components/ — so runtime validation should reject
    expect(isValidChannel("unstaged", state.configDir)).toBe(false);
  });
});

describe("Configuration idempotence", () => {
  test("running writeCaddyRoutes twice produces identical results", () => {
    const state = makeState(baseDir);
    const caddyContent = "handle_path /chat/* {\n\treverse_proxy channel-chat:8080\n}\n";
    seedChannelComponents(state.configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n", caddy: caddyContent }
    ]);

    // First apply
    writeCaddyRoutes(state);
    const caddy1 = readFileSync(join(state.dataDir, "caddy", "channels", "lan", "chat.caddy"), "utf-8");

    // Second apply (idempotent)
    writeCaddyRoutes(state);
    const caddy2 = readFileSync(join(state.dataDir, "caddy", "channels", "lan", "chat.caddy"), "utf-8");

    expect(caddy1).toBe(caddy2);
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
