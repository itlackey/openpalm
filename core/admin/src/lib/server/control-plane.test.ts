/**
 * Comprehensive tests for control-plane.ts exported functions.
 *
 * Covers: pure utility functions, channel validation/discovery, access scope
 * management, channel install/uninstall, secrets management, audit logging,
 * connection key management, artifact staging, XDG directory setup, and
 * lifecycle state transitions.
 *
 * Tests verify behavior documented in docs/core-principles.md and docs/api-spec.md.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createState,
  randomHex,
  sha256,
  discoverChannels,
  isAllowedService,
  isAllowedAction,
  isValidChannel,
  normalizeCaller,
  buildComposeFileList,
  buildArtifactMeta,
  detectAccessScope,
  installChannelFromRegistry,
  uninstallChannel,
  ensureSecrets,
  updateSecretsEnv,
  readSecretsEnvFile,
  patchSecretsEnvFile,
  maskConnectionValue,
  appendAudit,
  stagedEnvFile,
  stagedStackEnvFile,
  buildEnvFiles,
  discoverStagedChannelYmls,
  applyInstall,
  applyUpdate,
  applyUninstall,
  persistArtifacts,
  ensureXdgDirs,
  ensureOpenCodeConfig,
  ensureCoreCaddyfile,
  setCoreCaddyAccessScope,
  CORE_SERVICES,
  ALLOWED_CONNECTION_KEYS,
  REQUIRED_LLM_PROVIDER_KEYS,
  PLAIN_CONFIG_KEYS,
  REGISTRY_CHANNEL_NAMES,
  type ControlPlaneState,
  type CallerType,
  type AuditEntry
} from "./control-plane.js";

// ── Test helpers ────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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

function makeTestState(overrides: Partial<ControlPlaneState> = {}): ControlPlaneState {
  const stateDir = makeTempDir();
  const configDir = makeTempDir();
  const dataDir = makeTempDir();
  return {
    adminToken: "test-admin-token",
    setupToken: "test-setup-token",
    postgresPassword: "test-pg-password",
    stateDir,
    configDir,
    dataDir,
    services: {},
    installedExtensions: new Set<string>(),
    artifacts: { compose: "", caddyfile: "" },
    artifactMeta: [],
    audit: [],
    channelSecrets: {},
    ...overrides
  };
}

let tempDirs: string[] = [];

function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

// ── Pure Utility Functions ──────────────────────────────────────────────

describe("randomHex", () => {
  test("returns hex string of expected length", () => {
    const result = randomHex(16);
    expect(result).toHaveLength(32); // 16 bytes = 32 hex chars
    expect(result).toMatch(/^[a-f0-9]+$/);
  });

  test("returns different values on successive calls", () => {
    const a = randomHex(16);
    const b = randomHex(16);
    expect(a).not.toBe(b);
  });

  test("respects byte count parameter", () => {
    expect(randomHex(4)).toHaveLength(8);
    expect(randomHex(32)).toHaveLength(64);
    expect(randomHex(1)).toHaveLength(2);
  });
});

describe("sha256", () => {
  test("produces consistent hash for same input", () => {
    const hash1 = sha256("hello world");
    const hash2 = sha256("hello world");
    expect(hash1).toBe(hash2);
  });

  test("produces known hash for known input", () => {
    // SHA-256 of empty string
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  test("different inputs produce different hashes", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });

  test("returns 64-char lowercase hex string", () => {
    const hash = sha256("test");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
});

// ── Channel Name Validation & Discovery ─────────────────────────────────

describe("discoverChannels", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("returns empty array when channels dir does not exist", () => {
    const result = discoverChannels(configDir);
    expect(result).toEqual([]);
  });

  test("discovers .yml files as channels", () => {
    seedConfigChannels(configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n" }
    ]);

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("chat");
    expect(result[0].hasRoute).toBe(false);
    expect(result[0].ymlPath).toContain("chat.yml");
    expect(result[0].caddyPath).toBeNull();
  });

  test("detects hasRoute when .caddy file is present", () => {
    seedConfigChannels(configDir, [
      {
        name: "chat",
        yml: "services:\n  channel-chat:\n    image: chat:latest\n",
        caddy: "handle_path /chat/* {\n\treverse_proxy channel-chat:8080\n}\n"
      }
    ]);

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].hasRoute).toBe(true);
    expect(result[0].caddyPath).toContain("chat.caddy");
  });

  test("discovers multiple channels", () => {
    seedConfigChannels(configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n" },
      { name: "discord", yml: "services:\n  channel-discord:\n    image: discord:latest\n" },
      { name: "api", yml: "services:\n  channel-api:\n    image: api:latest\n" }
    ]);

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(3);
    const names = result.map((c) => c.name).sort();
    expect(names).toEqual(["api", "chat", "discord"]);
  });

  test("filters out invalid channel names", () => {
    const channelsDir = join(configDir, "channels");
    mkdirSync(channelsDir, { recursive: true });
    // Invalid names: uppercase, starts with hyphen, too long, special chars
    writeFileSync(join(channelsDir, "UPPER.yml"), "services: {}");
    writeFileSync(join(channelsDir, "-leading-hyphen.yml"), "services: {}");
    writeFileSync(join(channelsDir, "has spaces.yml"), "services: {}");
    writeFileSync(join(channelsDir, "valid-name.yml"), "services: {}");

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("valid-name");
  });

  test("ignores non-.yml files in channels directory", () => {
    const channelsDir = join(configDir, "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "readme.md"), "# Notes");
    writeFileSync(join(channelsDir, "chat.yml"), "services: {}");
    writeFileSync(join(channelsDir, "backup.yml.bak"), "old");

    const result = discoverChannels(configDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("chat");
  });
});

// ── Allowlist & Validation Functions ────────────────────────────────────

describe("isAllowedService", () => {
  test("allows all core services", () => {
    for (const service of CORE_SERVICES) {
      expect(isAllowedService(service)).toBe(true);
    }
  });

  test("rejects empty string", () => {
    expect(isAllowedService("")).toBe(false);
  });

  test("rejects whitespace-only string", () => {
    expect(isAllowedService("   ")).toBe(false);
  });

  test("rejects uppercase service names (case-sensitive per doc)", () => {
    expect(isAllowedService("Admin")).toBe(false);
    expect(isAllowedService("GUARDIAN")).toBe(false);
  });

  test("allows channel-* when staged yml exists", () => {
    const stateDir = trackDir(makeTempDir());
    const channelsDir = join(stateDir, "artifacts", "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "chat.yml"), "services: {}");

    expect(isAllowedService("channel-chat", stateDir)).toBe(true);
  });

  test("rejects channel-* when staged yml does not exist", () => {
    const stateDir = trackDir(makeTempDir());
    expect(isAllowedService("channel-chat", stateDir)).toBe(false);
  });

  test("rejects channel- with invalid channel name", () => {
    const stateDir = trackDir(makeTempDir());
    expect(isAllowedService("channel-UPPER", stateDir)).toBe(false);
    expect(isAllowedService("channel--double", stateDir)).toBe(false);
  });

  test("rejects non-core, non-channel services", () => {
    expect(isAllowedService("unknown-service")).toBe(false);
    expect(isAllowedService("nginx")).toBe(false);
  });
});

describe("isAllowedAction", () => {
  test("allows documented actions from api-spec.md", () => {
    const validActions = [
      "install", "update", "uninstall",
      "containers.list", "containers.pull", "containers.up",
      "containers.down", "containers.restart",
      "channels.list", "channels.install", "channels.uninstall",
      "extensions.list", "extensions.install", "extensions.uninstall",
      "gallery.refresh",
      "artifacts.list", "artifacts.get", "artifacts.manifest",
      "audit.list",
      "accessScope.get", "accessScope.set",
      "connections.get", "connections.patch", "connections.status"
    ];
    for (const action of validActions) {
      expect(isAllowedAction(action)).toBe(true);
    }
  });

  test("rejects invalid actions", () => {
    expect(isAllowedAction("")).toBe(false);
    expect(isAllowedAction("destroy")).toBe(false);
    expect(isAllowedAction("INSTALL")).toBe(false);
    expect(isAllowedAction("admin.delete")).toBe(false);
  });
});

describe("isValidChannel", () => {
  test("validates channel name format (lowercase alnum + hyphens)", () => {
    const stateDir = trackDir(makeTempDir());
    const channelsDir = join(stateDir, "artifacts", "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "my-channel.yml"), "services: {}");

    expect(isValidChannel("my-channel", stateDir)).toBe(true);
  });

  test("rejects empty and whitespace", () => {
    expect(isValidChannel("")).toBe(false);
    expect(isValidChannel("  ")).toBe(false);
  });

  test("rejects invalid names even without stateDir", () => {
    expect(isValidChannel("UPPER")).toBe(false);
    expect(isValidChannel("-leading")).toBe(false);
    expect(isValidChannel("has space")).toBe(false);
  });

  test("requires stateDir to confirm staging", () => {
    // Without stateDir: format-valid but returns false (no staged file check)
    expect(isValidChannel("chat")).toBe(false);
  });

  test("rejects valid-format name if not staged", () => {
    const stateDir = trackDir(makeTempDir());
    mkdirSync(join(stateDir, "artifacts", "channels"), { recursive: true });
    expect(isValidChannel("unstaged", stateDir)).toBe(false);
  });
});

// ── Caller Normalization ────────────────────────────────────────────────

describe("normalizeCaller", () => {
  test("normalizes valid caller types", () => {
    expect(normalizeCaller("assistant")).toBe("assistant");
    expect(normalizeCaller("cli")).toBe("cli");
    expect(normalizeCaller("ui")).toBe("ui");
    expect(normalizeCaller("system")).toBe("system");
    expect(normalizeCaller("test")).toBe("test");
  });

  test("handles case-insensitive input", () => {
    expect(normalizeCaller("UI")).toBe("ui");
    expect(normalizeCaller("CLI")).toBe("cli");
    expect(normalizeCaller("System")).toBe("system");
  });

  test("trims whitespace", () => {
    expect(normalizeCaller("  ui  ")).toBe("ui");
  });

  test("returns 'unknown' for invalid callers", () => {
    expect(normalizeCaller("")).toBe("unknown");
    expect(normalizeCaller("browser")).toBe("unknown");
    expect(normalizeCaller("api")).toBe("unknown");
    expect(normalizeCaller("admin")).toBe("unknown");
  });

  test("returns 'unknown' for null", () => {
    expect(normalizeCaller(null)).toBe("unknown");
  });
});

// ── Access Scope Detection ──────────────────────────────────────────────

describe("detectAccessScope", () => {
  test("detects host-only scope", () => {
    const caddyfile = `
:8080 {
  @denied not remote_ip 127.0.0.0/8 ::1
  respond @denied 403
}`;
    expect(detectAccessScope(caddyfile)).toBe("host");
  });

  test("detects LAN scope", () => {
    const caddyfile = `
:8080 {
  @denied not remote_ip 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 ::1 fc00::/7 fe80::/10
  respond @denied 403
}`;
    expect(detectAccessScope(caddyfile)).toBe("lan");
  });

  test("returns custom for unknown IP ranges", () => {
    const caddyfile = `
:8080 {
  @denied not remote_ip 192.168.1.0/24
  respond @denied 403
}`;
    expect(detectAccessScope(caddyfile)).toBe("custom");
  });

  test("returns custom when @denied line is missing", () => {
    const caddyfile = `:8080 {\n  respond "OK"\n}`;
    expect(detectAccessScope(caddyfile)).toBe("custom");
  });
});

// ── Artifact Metadata ───────────────────────────────────────────────────

describe("buildArtifactMeta", () => {
  test("generates metadata for compose and caddyfile", () => {
    const artifacts = {
      compose: "services:\n  admin:\n    image: admin:latest\n",
      caddyfile: ":8080 {\n  respond 200\n}"
    };
    const meta = buildArtifactMeta(artifacts);
    expect(meta).toHaveLength(2);
    expect(meta[0].name).toBe("compose");
    expect(meta[1].name).toBe("caddyfile");
  });

  test("sha256 matches content hash", () => {
    const content = "test content";
    const artifacts = { compose: content, caddyfile: "" };
    const meta = buildArtifactMeta(artifacts);
    expect(meta[0].sha256).toBe(sha256(content));
    expect(meta[1].sha256).toBe(sha256(""));
  });

  test("bytes reflects buffer byte length (handles multibyte)", () => {
    const artifacts = { compose: "hello", caddyfile: "\u00e9" }; // é = 2 bytes UTF-8
    const meta = buildArtifactMeta(artifacts);
    expect(meta[0].bytes).toBe(5);
    expect(meta[1].bytes).toBe(2);
  });

  test("generatedAt is ISO timestamp", () => {
    const meta = buildArtifactMeta({ compose: "", caddyfile: "" });
    expect(meta[0].generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── Staged Channel Discovery ────────────────────────────────────────────

describe("discoverStagedChannelYmls", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = trackDir(makeTempDir());
  });

  test("returns empty when channels dir does not exist", () => {
    expect(discoverStagedChannelYmls(stateDir)).toEqual([]);
  });

  test("discovers staged .yml files", () => {
    const channelsDir = join(stateDir, "artifacts", "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "chat.yml"), "services: {}");
    writeFileSync(join(channelsDir, "discord.yml"), "services: {}");

    const result = discoverStagedChannelYmls(stateDir);
    expect(result).toHaveLength(2);
    expect(result.every((f) => f.startsWith(stateDir))).toBe(true);
  });

  test("ignores non-.yml files", () => {
    const channelsDir = join(stateDir, "artifacts", "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "chat.yml"), "services: {}");
    writeFileSync(join(channelsDir, "chat.caddy"), "handle /chat {}");

    const result = discoverStagedChannelYmls(stateDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/chat\.yml$/);
  });

  test("ignores subdirectories (only files)", () => {
    const channelsDir = join(stateDir, "artifacts", "channels");
    mkdirSync(channelsDir, { recursive: true });
    mkdirSync(join(channelsDir, "public"), { recursive: true });
    mkdirSync(join(channelsDir, "lan"), { recursive: true });
    writeFileSync(join(channelsDir, "chat.yml"), "services: {}");

    const result = discoverStagedChannelYmls(stateDir);
    expect(result).toHaveLength(1);
  });
});

// ── Build Compose File List ─────────────────────────────────────────────

describe("buildComposeFileList", () => {
  test("starts with core compose from artifacts dir", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const files = buildComposeFileList(state);
    expect(files[0]).toBe(`${state.stateDir}/artifacts/docker-compose.yml`);
  });

  test("includes staged channel overlays", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const channelsDir = join(state.stateDir, "artifacts", "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "chat.yml"), "services: {}");

    const files = buildComposeFileList(state);
    expect(files).toHaveLength(2);
    expect(files[1]).toContain("chat.yml");
  });
});

// ── Path Helpers ────────────────────────────────────────────────────────

describe("stagedEnvFile", () => {
  test("returns STATE_HOME/artifacts/secrets.env", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);
    expect(stagedEnvFile(state)).toBe(`${state.stateDir}/artifacts/secrets.env`);
  });
});

describe("stagedStackEnvFile", () => {
  test("returns STATE_HOME/artifacts/stack.env", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);
    expect(stagedStackEnvFile(state)).toBe(`${state.stateDir}/artifacts/stack.env`);
  });
});

describe("buildEnvFiles", () => {
  test("only returns files that exist", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    // Neither file exists yet
    expect(buildEnvFiles(state)).toEqual([]);
  });

  test("returns both files when they exist", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const artifactDir = join(state.stateDir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "stack.env"), "KEY=val");
    writeFileSync(join(artifactDir, "secrets.env"), "SECRET=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("stack.env");
    expect(files[1]).toContain("secrets.env");
  });
});

// ── Secrets Management ──────────────────────────────────────────────────

describe("ensureSecrets", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("seeds secrets.env with empty ADMIN_TOKEN on first run", () => {
    const state = { configDir, adminToken: "preconfigured-token" } as ControlPlaneState;

    ensureSecrets(state);

    const secrets = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(secrets).toContain("ADMIN_TOKEN=\n");
    expect(secrets).not.toContain("ADMIN_TOKEN=preconfigured-token");
  });

  test("is idempotent — does not overwrite existing secrets.env", () => {
    const state = { configDir } as ControlPlaneState;
    const existingContent = "ADMIN_TOKEN=my-token\nOPENAI_API_KEY=sk-test\n";
    seedSecretsEnv(configDir, existingContent);

    ensureSecrets(state);

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toBe(existingContent);
  });

  test("includes LLM provider key placeholders", () => {
    const state = { configDir } as ControlPlaneState;
    ensureSecrets(state);

    const secrets = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(secrets).toContain("OPENAI_API_KEY=");
    expect(secrets).toContain("GROQ_API_KEY=");
    expect(secrets).toContain("MISTRAL_API_KEY=");
    expect(secrets).toContain("GOOGLE_API_KEY=");
  });

  test("creates config directory if missing", () => {
    const nestedDir = join(configDir, "deep", "nested");
    const state = { configDir: nestedDir } as ControlPlaneState;

    ensureSecrets(state);

    expect(existsSync(join(nestedDir, "secrets.env"))).toBe(true);
  });
});

describe("updateSecretsEnv", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("throws when secrets.env does not exist", () => {
    const state = { configDir } as ControlPlaneState;
    expect(() => updateSecretsEnv(state, { KEY: "val" })).toThrow(
      "secrets.env does not exist"
    );
  });

  test("updates existing key in-place", () => {
    seedSecretsEnv(configDir, "ADMIN_TOKEN=token\nOPENAI_API_KEY=old\n");
    const state = { configDir } as ControlPlaneState;

    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-new" });

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=sk-new");
    expect(result).not.toContain("old");
    expect(result).toContain("ADMIN_TOKEN=token");
  });

  test("uncomments and updates commented-out keys", () => {
    seedSecretsEnv(configDir, "ADMIN_TOKEN=token\n# OPENAI_API_KEY=\n");
    const state = { configDir } as ControlPlaneState;

    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-uncommented" });

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=sk-uncommented");
    expect(result).not.toContain("# OPENAI_API_KEY");
  });

  test("appends keys not found in file", () => {
    seedSecretsEnv(configDir, "ADMIN_TOKEN=token\n");
    const state = { configDir } as ControlPlaneState;

    updateSecretsEnv(state, { NEW_KEY: "new-value" });

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("NEW_KEY=new-value");
    expect(result).toContain("ADMIN_TOKEN=token");
  });

  test("empty updates leave file unchanged", () => {
    const original = "ADMIN_TOKEN=token\n";
    seedSecretsEnv(configDir, original);
    const state = { configDir } as ControlPlaneState;

    updateSecretsEnv(state, {});

    expect(readFileSync(join(configDir, "secrets.env"), "utf-8")).toBe(original);
  });
});

// ── Connection Key Management ───────────────────────────────────────────

describe("readSecretsEnvFile", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("returns empty object when file does not exist", () => {
    expect(readSecretsEnvFile(configDir)).toEqual({});
  });

  test("reads only ALLOWED_CONNECTION_KEYS", () => {
    seedSecretsEnv(
      configDir,
      "ADMIN_TOKEN=secret\nOPENAI_API_KEY=sk-test\nRANDOM_KEY=val\n"
    );

    const result = readSecretsEnvFile(configDir);
    expect(result.OPENAI_API_KEY).toBe("sk-test");
    expect(result.ADMIN_TOKEN).toBeUndefined(); // ADMIN_TOKEN is not in ALLOWED_CONNECTION_KEYS
    expect(result.RANDOM_KEY).toBeUndefined();
  });

  test("skips comments and blank lines", () => {
    seedSecretsEnv(configDir, "# A comment\n\nOPENAI_API_KEY=sk-test\n# another\n");
    const result = readSecretsEnvFile(configDir);
    expect(result.OPENAI_API_KEY).toBe("sk-test");
  });

  test("strips inline comments from values", () => {
    seedSecretsEnv(configDir, "OPENAI_API_KEY=sk-test # my key\n");
    const result = readSecretsEnvFile(configDir);
    expect(result.OPENAI_API_KEY).toBe("sk-test");
  });

  test("unquotes single and double quoted values", () => {
    seedSecretsEnv(
      configDir,
      'OPENAI_API_KEY="sk-double"\nGROQ_API_KEY=\'sk-single\'\n'
    );
    const result = readSecretsEnvFile(configDir);
    expect(result.OPENAI_API_KEY).toBe("sk-double");
    expect(result.GROQ_API_KEY).toBe("sk-single");
  });

  test("returns empty string for keys with no value", () => {
    seedSecretsEnv(configDir, "OPENAI_API_KEY=\n");
    const result = readSecretsEnvFile(configDir);
    expect(result.OPENAI_API_KEY).toBe("");
  });
});

describe("patchSecretsEnvFile", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("only patches ALLOWED_CONNECTION_KEYS", () => {
    seedSecretsEnv(configDir, "ADMIN_TOKEN=token\nOPENAI_API_KEY=old\n");
    patchSecretsEnvFile(configDir, {
      OPENAI_API_KEY: "sk-new",
      ADMIN_TOKEN: "hacked", // NOT in ALLOWED_CONNECTION_KEYS
      RANDOM_KEY: "injected" // NOT in ALLOWED_CONNECTION_KEYS
    });

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=sk-new");
    expect(result).toContain("ADMIN_TOKEN=token"); // unchanged
    expect(result).not.toContain("RANDOM_KEY");
    expect(result).not.toContain("hacked");
  });

  test("appends new allowed keys when not in file", () => {
    seedSecretsEnv(configDir, "OPENAI_API_KEY=existing\n");
    patchSecretsEnvFile(configDir, { GROQ_API_KEY: "gsk-new" });

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=existing");
    expect(result).toContain("GROQ_API_KEY=gsk-new");
  });

  test("creates file if it does not exist", () => {
    patchSecretsEnvFile(configDir, { OPENAI_API_KEY: "sk-created" });
    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=sk-created");
  });

  test("no-op when patches contain only disallowed keys", () => {
    const original = "ADMIN_TOKEN=keep\n";
    seedSecretsEnv(configDir, original);
    patchSecretsEnvFile(configDir, { ADMIN_TOKEN: "nope", RANDOM: "nope" });
    expect(readFileSync(join(configDir, "secrets.env"), "utf-8")).toBe(original);
  });

  test("preserves comments and non-allowed keys", () => {
    seedSecretsEnv(
      configDir,
      "# Config\nADMIN_TOKEN=secret\nOPENAI_API_KEY=old\nCUSTOM=val\n"
    );
    patchSecretsEnvFile(configDir, { OPENAI_API_KEY: "sk-updated" });

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("# Config");
    expect(result).toContain("ADMIN_TOKEN=secret");
    expect(result).toContain("CUSTOM=val");
    expect(result).toContain("OPENAI_API_KEY=sk-updated");
  });
});

describe("maskConnectionValue", () => {
  test("returns empty string for empty value", () => {
    expect(maskConnectionValue("OPENAI_API_KEY", "")).toBe("");
  });

  test("masks secret keys, showing last 4 chars", () => {
    expect(maskConnectionValue("OPENAI_API_KEY", "sk-test-1234abcd")).toBe(
      "*".repeat("sk-test-1234abcd".length - 4) + "abcd"
    );
  });

  test("fully masks short values (<=4 chars)", () => {
    expect(maskConnectionValue("OPENAI_API_KEY", "abcd")).toBe("****");
    expect(maskConnectionValue("OPENAI_API_KEY", "ab")).toBe("****");
  });

  test("returns plain config keys unmasked (per api-spec.md)", () => {
    for (const key of PLAIN_CONFIG_KEYS) {
      expect(maskConnectionValue(key, "some-value")).toBe("some-value");
    }
  });

  test("GUARDIAN_LLM_PROVIDER is returned unmasked", () => {
    expect(maskConnectionValue("GUARDIAN_LLM_PROVIDER", "anthropic")).toBe("anthropic");
  });

  test("OPENMEMORY_OPENAI_BASE_URL is returned unmasked", () => {
    expect(maskConnectionValue("OPENMEMORY_OPENAI_BASE_URL", "http://localhost:11434")).toBe(
      "http://localhost:11434"
    );
  });
});

// ── Connection Key Sets ─────────────────────────────────────────────────

describe("ALLOWED_CONNECTION_KEYS", () => {
  test("includes all keys from api-spec.md", () => {
    const expectedKeys = [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GROQ_API_KEY",
      "MISTRAL_API_KEY",
      "GOOGLE_API_KEY",
      "GUARDIAN_LLM_PROVIDER",
      "GUARDIAN_LLM_MODEL",
      "OPENMEMORY_OPENAI_BASE_URL",
      "OPENMEMORY_OPENAI_API_KEY"
    ];
    for (const key of expectedKeys) {
      expect(ALLOWED_CONNECTION_KEYS.has(key)).toBe(true);
    }
  });

  test("does not include ADMIN_TOKEN (security: separate from connection keys)", () => {
    expect(ALLOWED_CONNECTION_KEYS.has("ADMIN_TOKEN")).toBe(false);
  });
});

describe("REQUIRED_LLM_PROVIDER_KEYS", () => {
  test("includes all LLM provider API key names from api-spec.md", () => {
    expect(REQUIRED_LLM_PROVIDER_KEYS).toContain("OPENAI_API_KEY");
    expect(REQUIRED_LLM_PROVIDER_KEYS).toContain("ANTHROPIC_API_KEY");
    expect(REQUIRED_LLM_PROVIDER_KEYS).toContain("GROQ_API_KEY");
    expect(REQUIRED_LLM_PROVIDER_KEYS).toContain("MISTRAL_API_KEY");
    expect(REQUIRED_LLM_PROVIDER_KEYS).toContain("GOOGLE_API_KEY");
  });

  test("all required keys are subset of allowed connection keys", () => {
    for (const key of REQUIRED_LLM_PROVIDER_KEYS) {
      expect(ALLOWED_CONNECTION_KEYS.has(key)).toBe(true);
    }
  });
});

// ── Audit Logging ───────────────────────────────────────────────────────

describe("appendAudit", () => {
  let state: ControlPlaneState;

  beforeEach(() => {
    state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);
  });

  test("appends entry to in-memory audit array", () => {
    appendAudit(state, "admin", "install", { target: "stack" }, true, "req-1", "ui");
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0].actor).toBe("admin");
    expect(state.audit[0].action).toBe("install");
    expect(state.audit[0].ok).toBe(true);
    expect(state.audit[0].requestId).toBe("req-1");
    expect(state.audit[0].callerType).toBe("ui");
  });

  test("includes ISO timestamp", () => {
    appendAudit(state, "admin", "test", {}, true);
    expect(state.audit[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("persists to JSONL file on disk", () => {
    appendAudit(state, "admin", "install", {}, true, "req-1");
    const auditFile = join(state.stateDir, "audit", "admin-audit.jsonl");
    expect(existsSync(auditFile)).toBe(true);
    const content = readFileSync(auditFile, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.action).toBe("install");
  });

  test("caps in-memory audit at 1000 entries (per MAX_AUDIT_MEMORY)", () => {
    for (let i = 0; i < 1050; i++) {
      appendAudit(state, "admin", `action-${i}`, {}, true);
    }
    expect(state.audit.length).toBe(1000);
    // Oldest entries should be trimmed; newest kept
    expect(state.audit[0].action).toBe("action-50");
    expect(state.audit[999].action).toBe("action-1049");
  });

  test("defaults requestId to empty string and callerType to unknown", () => {
    appendAudit(state, "admin", "test", {}, true);
    expect(state.audit[0].requestId).toBe("");
    expect(state.audit[0].callerType).toBe("unknown");
  });
});

// ── Channel Install / Uninstall ─────────────────────────────────────────

describe("installChannelFromRegistry", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("rejects invalid channel name", () => {
    const result = installChannelFromRegistry("INVALID", configDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid channel name");
  });

  test("rejects channel not in registry", () => {
    const result = installChannelFromRegistry("nonexistent-channel", configDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found in registry");
  });

  test("rejects already installed channel", () => {
    // Only test if there are registry channels available
    if (REGISTRY_CHANNEL_NAMES.length === 0) return;
    const name = REGISTRY_CHANNEL_NAMES[0];
    const channelsDir = join(configDir, "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, `${name}.yml`), "existing");

    const result = installChannelFromRegistry(name, configDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("already installed");
  });

  test("installs registry channel successfully", () => {
    if (REGISTRY_CHANNEL_NAMES.length === 0) return;
    const name = REGISTRY_CHANNEL_NAMES[0];

    const result = installChannelFromRegistry(name, configDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(configDir, "channels", `${name}.yml`))).toBe(true);
  });
});

describe("uninstallChannel", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("rejects invalid channel name", () => {
    const result = uninstallChannel("INVALID", configDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid channel name");
  });

  test("rejects when channel is not installed", () => {
    mkdirSync(join(configDir, "channels"), { recursive: true });
    const result = uninstallChannel("chat", configDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not installed");
  });

  test("removes .yml file on uninstall", () => {
    seedConfigChannels(configDir, [
      { name: "chat", yml: "services: {}" }
    ]);

    const result = uninstallChannel("chat", configDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(configDir, "channels", "chat.yml"))).toBe(false);
  });

  test("removes both .yml and .caddy files", () => {
    seedConfigChannels(configDir, [
      {
        name: "chat",
        yml: "services: {}",
        caddy: "handle_path /chat/* { reverse_proxy channel-chat:8080 }"
      }
    ]);

    const result = uninstallChannel("chat", configDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(configDir, "channels", "chat.yml"))).toBe(false);
    expect(existsSync(join(configDir, "channels", "chat.caddy"))).toBe(false);
  });
});

// ── Lifecycle State Transitions ─────────────────────────────────────────

describe("applyInstall", () => {
  test("marks all core services as running", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    // Initialize services as stopped
    for (const service of CORE_SERVICES) {
      state.services[service] = "stopped";
    }

    // Create required dirs for persistArtifacts
    mkdirSync(join(state.configDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "artifacts"), { recursive: true });
    mkdirSync(join(state.stateDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "secrets"), { recursive: true });
    mkdirSync(join(state.dataDir, "caddy"), { recursive: true });

    applyInstall(state);

    for (const service of CORE_SERVICES) {
      expect(state.services[service]).toBe("running");
    }
  });
});

describe("applyUpdate", () => {
  test("returns list of running services that were restarted", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);
    state.services = { admin: "running", guardian: "running", postgres: "stopped" };

    mkdirSync(join(state.configDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "artifacts"), { recursive: true });
    mkdirSync(join(state.stateDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "secrets"), { recursive: true });
    mkdirSync(join(state.dataDir, "caddy"), { recursive: true });

    const result = applyUpdate(state);
    expect(result.restarted).toContain("admin");
    expect(result.restarted).toContain("guardian");
    expect(result.restarted).not.toContain("postgres");
  });
});

describe("applyUninstall", () => {
  test("stops all services and clears extensions", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);
    state.services = { admin: "running", guardian: "running" };
    state.installedExtensions.add("plugin-a");

    mkdirSync(join(state.configDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "artifacts"), { recursive: true });
    mkdirSync(join(state.stateDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "secrets"), { recursive: true });
    mkdirSync(join(state.dataDir, "caddy"), { recursive: true });

    const result = applyUninstall(state);
    expect(result.stopped).toContain("admin");
    expect(result.stopped).toContain("guardian");

    for (const status of Object.values(state.services)) {
      expect(status).toBe("stopped");
    }
    expect(state.installedExtensions.size).toBe(0);
  });
});

// ── XDG Directory Setup ─────────────────────────────────────────────────

describe("ensureXdgDirs", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OPENPALM_CONFIG_HOME = process.env.OPENPALM_CONFIG_HOME;
    origEnv.OPENPALM_STATE_HOME = process.env.OPENPALM_STATE_HOME;
    origEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;

    const base = trackDir(makeTempDir());
    process.env.OPENPALM_CONFIG_HOME = join(base, "config");
    process.env.OPENPALM_STATE_HOME = join(base, "state");
    process.env.OPENPALM_DATA_HOME = join(base, "data");
  });

  afterEach(() => {
    process.env.OPENPALM_CONFIG_HOME = origEnv.OPENPALM_CONFIG_HOME;
    process.env.OPENPALM_STATE_HOME = origEnv.OPENPALM_STATE_HOME;
    process.env.OPENPALM_DATA_HOME = origEnv.OPENPALM_DATA_HOME;
  });

  test("creates full XDG directory tree", () => {
    ensureXdgDirs();

    const configHome = process.env.OPENPALM_CONFIG_HOME!;
    const stateHome = process.env.OPENPALM_STATE_HOME!;
    const dataHome = process.env.OPENPALM_DATA_HOME!;

    // CONFIG subtrees
    expect(existsSync(configHome)).toBe(true);
    expect(existsSync(join(configHome, "channels"))).toBe(true);
    expect(existsSync(join(configHome, "opencode"))).toBe(true);

    // STATE subtrees
    expect(existsSync(stateHome)).toBe(true);
    expect(existsSync(join(stateHome, "artifacts"))).toBe(true);
    expect(existsSync(join(stateHome, "audit"))).toBe(true);
    expect(existsSync(join(stateHome, "artifacts", "channels"))).toBe(true);

    // DATA subtrees
    expect(existsSync(dataHome)).toBe(true);
    expect(existsSync(join(dataHome, "postgres"))).toBe(true);
    expect(existsSync(join(dataHome, "qdrant"))).toBe(true);
    expect(existsSync(join(dataHome, "caddy"))).toBe(true);
    expect(existsSync(join(dataHome, "caddy", "data"))).toBe(true);
    expect(existsSync(join(dataHome, "caddy", "config"))).toBe(true);
  });

  test("is idempotent — safe to call multiple times", () => {
    ensureXdgDirs();
    ensureXdgDirs(); // No error
    expect(existsSync(process.env.OPENPALM_CONFIG_HOME!)).toBe(true);
  });
});

// ── OpenCode Config ─────────────────────────────────────────────────────

describe("ensureOpenCodeConfig", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OPENPALM_CONFIG_HOME = process.env.OPENPALM_CONFIG_HOME;
    process.env.OPENPALM_CONFIG_HOME = join(trackDir(makeTempDir()), "config");
  });

  afterEach(() => {
    process.env.OPENPALM_CONFIG_HOME = origEnv.OPENPALM_CONFIG_HOME;
  });

  test("seeds opencode.json with schema reference", () => {
    ensureOpenCodeConfig();

    const configFile = join(process.env.OPENPALM_CONFIG_HOME!, "opencode", "opencode.json");
    expect(existsSync(configFile)).toBe(true);
    const content = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(content.$schema).toBe("https://opencode.ai/config.json");
  });

  test("creates tools, plugins, skills subdirs", () => {
    ensureOpenCodeConfig();
    const base = join(process.env.OPENPALM_CONFIG_HOME!, "opencode");
    expect(existsSync(join(base, "tools"))).toBe(true);
    expect(existsSync(join(base, "plugins"))).toBe(true);
    expect(existsSync(join(base, "skills"))).toBe(true);
  });

  test("does not overwrite existing opencode.json", () => {
    const configHome = process.env.OPENPALM_CONFIG_HOME!;
    const opencodePath = join(configHome, "opencode");
    mkdirSync(opencodePath, { recursive: true });
    const customConfig = '{"custom": true}\n';
    writeFileSync(join(opencodePath, "opencode.json"), customConfig);

    ensureOpenCodeConfig();

    expect(readFileSync(join(opencodePath, "opencode.json"), "utf-8")).toBe(customConfig);
  });
});

// ── createState (exercises private loaders) ─────────────────────────────

describe("createState", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OPENPALM_CONFIG_HOME = process.env.OPENPALM_CONFIG_HOME;
    origEnv.OPENPALM_STATE_HOME = process.env.OPENPALM_STATE_HOME;
    origEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;
    origEnv.ADMIN_TOKEN = process.env.ADMIN_TOKEN;
  });

  afterEach(() => {
    process.env.OPENPALM_CONFIG_HOME = origEnv.OPENPALM_CONFIG_HOME;
    process.env.OPENPALM_STATE_HOME = origEnv.OPENPALM_STATE_HOME;
    process.env.OPENPALM_DATA_HOME = origEnv.OPENPALM_DATA_HOME;
    process.env.ADMIN_TOKEN = origEnv.ADMIN_TOKEN;
  });

  test("loads persisted postgres password from stack.env", () => {
    const base = trackDir(makeTempDir());
    process.env.OPENPALM_CONFIG_HOME = join(base, "config");
    process.env.OPENPALM_STATE_HOME = join(base, "state");
    process.env.OPENPALM_DATA_HOME = join(base, "data");
    delete process.env.ADMIN_TOKEN;

    // Seed DATA_HOME/stack.env with a known password
    const dataDir = join(base, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "stack.env"),
      "# Stack config\nPOSTGRES_PASSWORD=persisted-pg-pass\n"
    );

    const state = createState();
    expect(state.postgresPassword).toBe("persisted-pg-pass");
  });

  test("loads persisted channel secrets from stack.env", () => {
    const base = trackDir(makeTempDir());
    process.env.OPENPALM_CONFIG_HOME = join(base, "config");
    process.env.OPENPALM_STATE_HOME = join(base, "state");
    process.env.OPENPALM_DATA_HOME = join(base, "data");
    delete process.env.ADMIN_TOKEN;

    const dataDir = join(base, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "stack.env"),
      "# Stack config\nCHANNEL_CHAT_SECRET=abc123\nCHANNEL_DISCORD_SECRET=def456\n"
    );

    const state = createState();
    expect(state.channelSecrets.chat).toBe("abc123");
    expect(state.channelSecrets.discord).toBe("def456");
  });

  test("reads ADMIN_TOKEN from secrets.env file", () => {
    const base = trackDir(makeTempDir());
    process.env.OPENPALM_CONFIG_HOME = join(base, "config");
    process.env.OPENPALM_STATE_HOME = join(base, "state");
    process.env.OPENPALM_DATA_HOME = join(base, "data");
    delete process.env.ADMIN_TOKEN;

    mkdirSync(join(base, "config"), { recursive: true });
    writeFileSync(
      join(base, "config", "secrets.env"),
      "ADMIN_TOKEN=file-token\nOPENAI_API_KEY=sk-test\n"
    );

    const state = createState();
    expect(state.adminToken).toBe("file-token");
  });

  test("uses explicit adminToken parameter over file/env", () => {
    const base = trackDir(makeTempDir());
    process.env.OPENPALM_CONFIG_HOME = join(base, "config");
    process.env.OPENPALM_STATE_HOME = join(base, "state");
    process.env.OPENPALM_DATA_HOME = join(base, "data");
    process.env.ADMIN_TOKEN = "env-token";

    mkdirSync(join(base, "config"), { recursive: true });
    writeFileSync(join(base, "config", "secrets.env"), "ADMIN_TOKEN=file-token\n");

    const state = createState("explicit-token");
    expect(state.adminToken).toBe("explicit-token");
  });

  test("generates random postgres password when not persisted", () => {
    const base = trackDir(makeTempDir());
    process.env.OPENPALM_CONFIG_HOME = join(base, "config");
    process.env.OPENPALM_STATE_HOME = join(base, "state");
    process.env.OPENPALM_DATA_HOME = join(base, "data");

    const state = createState();
    // Should be a hex string (32 chars for 16 bytes)
    expect(state.postgresPassword).toMatch(/^[a-f0-9]{32}$/);
  });

  test("initializes all core services as stopped", () => {
    const base = trackDir(makeTempDir());
    process.env.OPENPALM_CONFIG_HOME = join(base, "config");
    process.env.OPENPALM_STATE_HOME = join(base, "state");
    process.env.OPENPALM_DATA_HOME = join(base, "data");

    const state = createState();
    for (const service of CORE_SERVICES) {
      expect(state.services[service]).toBe("stopped");
    }
  });
});

// ── Core Service Constants ──────────────────────────────────────────────

describe("CORE_SERVICES", () => {
  test("includes all expected services from docs", () => {
    expect(CORE_SERVICES).toContain("caddy");
    expect(CORE_SERVICES).toContain("postgres");
    expect(CORE_SERVICES).toContain("qdrant");
    expect(CORE_SERVICES).toContain("openmemory");
    expect(CORE_SERVICES).toContain("openmemory-ui");
    expect(CORE_SERVICES).toContain("assistant");
    expect(CORE_SERVICES).toContain("guardian");
    expect(CORE_SERVICES).toContain("admin");
  });

  test("has exactly 8 core services", () => {
    expect(CORE_SERVICES).toHaveLength(8);
  });
});

// ── Persist Artifacts (Integration) ─────────────────────────────────────

describe("persistArtifacts", () => {
  let state: ControlPlaneState;

  beforeEach(() => {
    state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);
    state.artifacts = {
      compose: "services:\n  admin:\n    image: admin:latest\n",
      caddyfile: ":8080 {\n  respond 200\n}"
    };
    // Create required base dirs
    mkdirSync(join(state.configDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "artifacts", "channels"), { recursive: true });
    mkdirSync(join(state.dataDir, "caddy"), { recursive: true });
  });

  test("writes compose and caddyfile to STATE_HOME", () => {
    persistArtifacts(state);

    const composePath = join(state.stateDir, "artifacts", "docker-compose.yml");
    const caddyPath = join(state.stateDir, "artifacts", "Caddyfile");
    expect(existsSync(composePath)).toBe(true);
    expect(readFileSync(composePath, "utf-8")).toBe(state.artifacts.compose);
    expect(readFileSync(caddyPath, "utf-8")).toBe(state.artifacts.caddyfile);
  });

  test("writes manifest.json with artifact metadata", () => {
    persistArtifacts(state);

    const manifestPath = join(state.stateDir, "artifacts", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest).toHaveLength(2);
    expect(manifest[0].name).toBe("compose");
    expect(manifest[1].name).toBe("caddyfile");
  });

  test("persists system secrets (postgres password) in stack.env", () => {
    persistArtifacts(state);

    const stackEnvPath = join(state.stateDir, "artifacts", "stack.env");
    expect(existsSync(stackEnvPath)).toBe(true);
    const content = readFileSync(stackEnvPath, "utf-8");
    expect(content).toContain(`POSTGRES_PASSWORD=${state.postgresPassword}`);
  });

  test("generates channel secrets for discovered channels", () => {
    seedConfigChannels(state.configDir, [
      { name: "chat", yml: "services: {}" }
    ]);

    persistArtifacts(state);

    expect(state.channelSecrets.chat).toBeDefined();
    expect(state.channelSecrets.chat.length).toBeGreaterThan(0);

    const stackEnvPath = join(state.stateDir, "artifacts", "stack.env");
    const content = readFileSync(stackEnvPath, "utf-8");
    expect(content).toContain("CHANNEL_CHAT_SECRET=");
  });

  test("writes stack.env with runtime configuration", () => {
    persistArtifacts(state);

    const stackEnvPath = join(state.stateDir, "artifacts", "stack.env");
    expect(existsSync(stackEnvPath)).toBe(true);
    const content = readFileSync(stackEnvPath, "utf-8");
    expect(content).toContain(`OPENPALM_CONFIG_HOME=${state.configDir}`);
    expect(content).toContain(`OPENPALM_DATA_HOME=${state.dataDir}`);
    expect(content).toContain(`OPENPALM_STATE_HOME=${state.stateDir}`);
    expect(content).toContain(`POSTGRES_PASSWORD=${state.postgresPassword}`);
  });

  test("stages channel yml files from CONFIG to STATE", () => {
    seedConfigChannels(state.configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n" }
    ]);

    persistArtifacts(state);

    const stagedYml = join(state.stateDir, "artifacts", "channels", "chat.yml");
    expect(existsSync(stagedYml)).toBe(true);
  });
});

// ── Access Scope Management (Filesystem) ────────────────────────────────

describe("ensureCoreCaddyfile / setCoreCaddyAccessScope", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;
    process.env.OPENPALM_DATA_HOME = trackDir(makeTempDir());
  });

  afterEach(() => {
    process.env.OPENPALM_DATA_HOME = origEnv.OPENPALM_DATA_HOME;
  });

  test("ensureCoreCaddyfile creates Caddyfile if missing", () => {
    const path = ensureCoreCaddyfile();
    expect(existsSync(path)).toBe(true);
    expect(path).toContain("caddy/Caddyfile");
  });

  test("ensureCoreCaddyfile is idempotent", () => {
    const path1 = ensureCoreCaddyfile();
    const content1 = readFileSync(path1, "utf-8");
    const path2 = ensureCoreCaddyfile();
    const content2 = readFileSync(path2, "utf-8");
    expect(content1).toBe(content2);
  });

  test("setCoreCaddyAccessScope returns error if @denied line missing", () => {
    const dataHome = process.env.OPENPALM_DATA_HOME!;
    const caddyDir = join(dataHome, "caddy");
    mkdirSync(caddyDir, { recursive: true });
    writeFileSync(join(caddyDir, "Caddyfile"), ":8080 {\n  respond 200\n}");

    const result = setCoreCaddyAccessScope("host");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("@denied not remote_ip");
  });
});
