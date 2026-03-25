/**
 * Tests for registry sync functions.
 *
 * Tests validation, discovery, and materialization.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateBranch,
  validateRegistryUrl,
  isValidComponentName,
  getRegistryConfig,
  materializeRegistryCatalog,
  discoverRegistryComponents,
  discoverRegistryAutomations,
  getRegistryAutomation,
  enableAddon,
  disableAddonByName,
  installAutomationFromRegistry,
  uninstallAutomation,
} from "./registry.js";

// ── Validation Tests ─────────────────────────────────────────────────

describe("validateBranch", () => {
  it("accepts 'main'", () => {
    expect(validateBranch("main")).toBe("main");
  });

  it("accepts 'feat/my-branch'", () => {
    expect(validateBranch("feat/my-branch")).toBe("feat/my-branch");
  });

  it("accepts branch with dots and underscores", () => {
    expect(validateBranch("release_1.0.0")).toBe("release_1.0.0");
  });

  it("rejects branch with '..'", () => {
    expect(() => validateBranch("main/../hack")).toThrow("contains '..'");
  });

  it("rejects branch with spaces", () => {
    expect(() => validateBranch("my branch")).toThrow("Invalid registry branch name");
  });

  it("rejects empty string", () => {
    expect(() => validateBranch("")).toThrow("Invalid registry branch name");
  });

  it("rejects branch with shell metacharacters", () => {
    expect(() => validateBranch("main;rm -rf /")).toThrow("Invalid registry branch name");
  });

  it("rejects branch with backticks", () => {
    expect(() => validateBranch("`whoami`")).toThrow("Invalid registry branch name");
  });
});

describe("validateRegistryUrl", () => {
  it("accepts https:// URLs", () => {
    expect(validateRegistryUrl("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git"
    );
  });

  it("accepts git@ URLs", () => {
    expect(validateRegistryUrl("git@github.com:org/repo.git")).toBe(
      "git@github.com:org/repo.git"
    );
  });

  it("accepts absolute local paths", () => {
    expect(validateRegistryUrl("/tmp/openpalm-registry")).toBe("/tmp/openpalm-registry");
  });

  it("rejects http:// URLs", () => {
    expect(() => validateRegistryUrl("http://github.com/repo.git")).toThrow(
      "Invalid registry URL"
    );
  });

  it("rejects file:// URLs", () => {
    expect(() => validateRegistryUrl("file:///etc/passwd")).toThrow("Invalid registry URL");
  });

  it("rejects empty string", () => {
    expect(() => validateRegistryUrl("")).toThrow("Invalid registry URL");
  });

  it("rejects arbitrary strings", () => {
    expect(() => validateRegistryUrl("not-a-url")).toThrow("Invalid registry URL");
  });
});

describe("isValidComponentName", () => {
  it("accepts lowercase alpha names", () => {
    expect(isValidComponentName("chat")).toBe(true);
  });

  it("accepts names with hyphens", () => {
    expect(isValidComponentName("my-channel")).toBe(true);
  });

  it("accepts names with digits", () => {
    expect(isValidComponentName("channel2")).toBe(true);
  });

  it("rejects uppercase", () => {
    expect(isValidComponentName("MyChannel")).toBe(false);
  });

  it("rejects names starting with hyphen", () => {
    expect(isValidComponentName("-bad")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidComponentName("")).toBe(false);
  });

  it("rejects names with dots", () => {
    expect(isValidComponentName("my.channel")).toBe(false);
  });

  it("rejects names longer than 63 chars", () => {
    expect(isValidComponentName("a".repeat(64))).toBe(false);
  });

  it("accepts names exactly 63 chars", () => {
    expect(isValidComponentName("a".repeat(63))).toBe(true);
  });
});

describe("getRegistryConfig", () => {
  const origUrl = process.env.OP_REGISTRY_URL;
  const origBranch = process.env.OP_REGISTRY_BRANCH;

  afterEach(() => {
    if (origUrl === undefined) delete process.env.OP_REGISTRY_URL;
    else process.env.OP_REGISTRY_URL = origUrl;
    if (origBranch === undefined) delete process.env.OP_REGISTRY_BRANCH;
    else process.env.OP_REGISTRY_BRANCH = origBranch;
  });

  it("returns defaults when env vars are unset", () => {
    delete process.env.OP_REGISTRY_URL;
    delete process.env.OP_REGISTRY_BRANCH;
    const config = getRegistryConfig();
    expect(config.repoUrl).toContain("github.com");
    expect(config.branch).toBe("main");
  });

  it("respects OP_REGISTRY_URL", () => {
    process.env.OP_REGISTRY_URL = "https://github.com/custom/repo.git";
    const config = getRegistryConfig();
    expect(config.repoUrl).toBe("https://github.com/custom/repo.git");
  });

  it("respects OP_REGISTRY_BRANCH", () => {
    process.env.OP_REGISTRY_BRANCH = "develop";
    const config = getRegistryConfig();
    expect(config.branch).toBe("develop");
  });

  it("throws on invalid branch in env", () => {
    process.env.OP_REGISTRY_BRANCH = "main;exploit";
    expect(() => getRegistryConfig()).toThrow("Invalid registry branch name");
  });

  it("throws on invalid URL in env", () => {
    process.env.OP_REGISTRY_URL = "ftp://bad.com/repo";
    expect(() => getRegistryConfig()).toThrow("Invalid registry URL");
  });
});

// ── Materialized Catalog Tests ───────────────────────────────────────

describe("materialized registry catalog", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    originalHome = process.env.OP_HOME;
    process.env.OP_HOME = join(tmpDir, 'home');
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("materializes addons and automations into OP_HOME/registry", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'registry', 'addons', 'chat');
    const automationsDir = join(sourceRoot, '.openpalm', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services: {}\n');
    writeFileSync(join(addonDir, '.env.schema'), 'CHANNEL_CHAT_SECRET=\n');
    writeFileSync(join(automationsDir, 'cleanup.yml'), 'description: Cleanup\nschedule: daily\n');

    const root = materializeRegistryCatalog(sourceRoot);

    expect(root).toBe(join(process.env.OP_HOME!, 'registry'));
    expect(existsSync(join(root, 'addons', 'chat', 'compose.yml'))).toBe(true);
    expect(existsSync(join(root, 'addons', 'chat', '.env.schema'))).toBe(true);
    expect(readFileSync(join(root, 'automations', 'cleanup.yml'), 'utf-8')).toContain('Cleanup');
  });

  it("discovers materialized registry entries", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'registry', 'addons', 'chat');
    const automationsDir = join(sourceRoot, '.openpalm', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services: {}\n');
    writeFileSync(join(addonDir, '.env.schema'), 'CHANNEL_CHAT_SECRET=\n');
    writeFileSync(join(automationsDir, 'cleanup.yml'), 'description: Cleanup\nschedule: daily\n');

    materializeRegistryCatalog(sourceRoot);

    const components = discoverRegistryComponents();
    const automations = discoverRegistryAutomations();

    expect(Object.keys(components)).toEqual(['chat']);
    expect(components.chat?.schema).toContain('CHANNEL_CHAT_SECRET');
    expect(automations.map((entry) => entry.name)).toEqual(['cleanup']);
    expect(getRegistryAutomation('cleanup')).toContain('schedule: daily');
  });

  it("fails when source catalog is incomplete", () => {
    const sourceRoot = join(tmpDir, 'repo');
    mkdirSync(join(sourceRoot, '.openpalm', 'registry', 'addons'), { recursive: true });
    mkdirSync(join(sourceRoot, '.openpalm', 'registry', 'automations'), { recursive: true });

    expect(() => materializeRegistryCatalog(sourceRoot)).toThrow('Registry catalog is incomplete');
  });

  it("enables and disables addons through the runtime stack directory", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'registry', 'addons', 'chat');
    const automationsDir = join(sourceRoot, '.openpalm', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services: {}\n');
    writeFileSync(join(addonDir, '.env.schema'), 'CHANNEL_CHAT_SECRET=\n');
    writeFileSync(join(automationsDir, 'cleanup.yml'), 'description: Cleanup\nschedule: daily\n');

    materializeRegistryCatalog(sourceRoot);

    expect(enableAddon(process.env.OP_HOME!, 'chat')).toEqual({ ok: true });
    expect(existsSync(join(process.env.OP_HOME!, 'stack', 'addons', 'chat', 'compose.yml'))).toBe(true);

    expect(disableAddonByName(process.env.OP_HOME!, 'chat')).toEqual({ ok: true });
    expect(existsSync(join(process.env.OP_HOME!, 'stack', 'addons', 'chat'))).toBe(false);
  });

  it("installs and uninstalls automations through config/automations", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'registry', 'addons', 'chat');
    const automationsDir = join(sourceRoot, '.openpalm', 'registry', 'automations');
    const configDir = join(process.env.OP_HOME!, 'config');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services: {}\n');
    writeFileSync(join(addonDir, '.env.schema'), 'CHANNEL_CHAT_SECRET=\n');
    writeFileSync(join(automationsDir, 'cleanup.yml'), 'description: Cleanup\nschedule: daily\n');

    materializeRegistryCatalog(sourceRoot);

    expect(installAutomationFromRegistry('cleanup', configDir)).toEqual({ ok: true });
    expect(readFileSync(join(configDir, 'automations', 'cleanup.yml'), 'utf-8')).toContain('Cleanup');

    expect(uninstallAutomation('cleanup', configDir)).toEqual({ ok: true });
    expect(existsSync(join(configDir, 'automations', 'cleanup.yml'))).toBe(false);
  });
});
