/**
 * Tests for registry sync functions.
 *
 * Tests validation, discovery, and materialization.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backupOpenPalmHome } from "./backup.js";
import {
  validateBranch,
  validateRegistryUrl,
  isValidComponentName,
  getRegistryConfig,
  materializeRegistryCatalog,
  verifyRegistryCatalog,
  discoverRegistryComponents,
  discoverRegistryAutomations,
  getRegistryAutomation,
  getRegistryAddonConfig,
  listAvailableAddonIds,
  getAddonServiceNames,
  getAddonProfiles,
  getAddonProfileSelection,
  setAddonProfileSelection,
  enableAddon,
  disableAddonByName,
  setAddonEnabled,
  installAutomationFromRegistry,
  uninstallAutomation,
  getAddonProfileAvailability,
  annotateAddonProfileAvailability,
  __addonAvailabilityTestHooks,
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
    const addonDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'addons', 'chat');
    const automationsDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services: {}\n');
    writeFileSync(join(addonDir, '.env.schema'), 'CHANNEL_CHAT_SECRET=\n');
    writeFileSync(join(automationsDir, 'cleanup.md'), '---\ndescription: Cleanup\nschedule: "0 3 * * *"\ncommand: ["echo","clean"]\n---\n');

    const root = materializeRegistryCatalog(sourceRoot);

    expect(root).toBe(join(process.env.OP_HOME!, 'state', 'registry'));
    expect(existsSync(join(root, 'addons', 'chat', 'compose.yml'))).toBe(true);
    expect(existsSync(join(root, 'addons', 'chat', '.env.schema'))).toBe(true);
    expect(readFileSync(join(root, 'automations', 'cleanup.md'), 'utf-8')).toContain('Cleanup');
  });

  it("discovers materialized registry entries", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'addons', 'chat');
    const automationsDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services: {}\n');
    writeFileSync(join(addonDir, '.env.schema'), 'CHANNEL_CHAT_SECRET=\n');
    writeFileSync(join(automationsDir, 'cleanup.md'), '---\ndescription: Cleanup\nschedule: "0 3 * * *"\ncommand: ["echo","clean"]\n---\n');

    materializeRegistryCatalog(sourceRoot);

    const components = discoverRegistryComponents();
    const stashDir = join(process.env.OP_HOME!, 'stash');
    const automations = discoverRegistryAutomations(stashDir);

    expect(Object.keys(components)).toEqual(['chat']);
    expect(components.chat?.schema).toContain('CHANNEL_CHAT_SECRET');
    expect(automations.map((entry) => entry.name)).toEqual(['cleanup']);
    expect(getRegistryAutomation('cleanup')).toContain('schedule: "0 3 * * *"');
  });

  it("returns addon config metadata from the materialized registry", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'addons', 'chat');
    const automationsDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services: {}\n');
    writeFileSync(join(addonDir, '.env.schema'), 'CHANNEL_CHAT_SECRET=\n');
    writeFileSync(join(automationsDir, 'cleanup.md'), '---\ndescription: Cleanup\nschedule: "0 3 * * *"\ncommand: ["echo","clean"]\n---\n');

    materializeRegistryCatalog(sourceRoot);

    expect(getRegistryAddonConfig(process.env.OP_HOME!, 'chat')).toEqual({
      schemaPath: 'state/registry/addons/chat/.env.schema',
      userEnvPath: 'config/stack/stack.env',
      envSchema: 'CHANNEL_CHAT_SECRET=\n',
    });
  });

  it("verifies the materialized registry and returns counts", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'addons', 'chat');
    const automationsDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services: {}\n');
    writeFileSync(join(addonDir, '.env.schema'), 'CHANNEL_CHAT_SECRET=\n');
    writeFileSync(join(automationsDir, 'cleanup.md'), '---\ndescription: Cleanup\nschedule: "0 3 * * *"\ncommand: ["echo","clean"]\n---\n');

    const root = materializeRegistryCatalog(sourceRoot);

    expect(verifyRegistryCatalog(root)).toEqual({
      root,
      addonCount: 1,
      automationCount: 1,
    });
  });

  it("returns no available addons when the registry addons directory is missing", () => {
    expect(listAvailableAddonIds()).toEqual([]);
  });

  it("fails when source catalog is incomplete", () => {
    const sourceRoot = join(tmpDir, 'repo');
    mkdirSync(join(sourceRoot, '.openpalm', 'state', 'registry', 'addons'), { recursive: true });
    mkdirSync(join(sourceRoot, '.openpalm', 'state', 'registry', 'automations'), { recursive: true });

    expect(() => materializeRegistryCatalog(sourceRoot)).toThrow('Registry catalog is incomplete');
  });

  it("enables and disables addons through the runtime stack directory", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'addons', 'chat');
    const automationsDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services: {}\n');
    writeFileSync(join(addonDir, '.env.schema'), 'CHANNEL_CHAT_SECRET=\n');
    writeFileSync(join(automationsDir, 'cleanup.md'), '---\ndescription: Cleanup\nschedule: "0 3 * * *"\ncommand: ["echo","clean"]\n---\n');

    materializeRegistryCatalog(sourceRoot);

    expect(enableAddon(process.env.OP_HOME!, 'chat')).toEqual({ ok: true });
    expect(existsSync(join(process.env.OP_HOME!, 'config', 'stack', 'addons', 'chat', 'compose.yml'))).toBe(true);

    expect(disableAddonByName(process.env.OP_HOME!, 'chat')).toEqual({ ok: true });
    expect(existsSync(join(process.env.OP_HOME!, 'config', 'stack', 'addons', 'chat'))).toBe(false);
  });

  it("returns addon service names from stack or registry compose files", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'addons', 'proxy-test');
    const automationsDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services:\n  svc-a:\n    image: image-a\n  svc-b:\n    image: image-b\n');
    writeFileSync(join(addonDir, '.env.schema'), 'PROXY_TOKEN=\n');
    writeFileSync(join(automationsDir, 'cleanup.md'), '---\ndescription: Cleanup\nschedule: "0 3 * * *"\ncommand: ["echo","clean"]\n---\n');

    materializeRegistryCatalog(sourceRoot);

    expect(getAddonServiceNames(process.env.OP_HOME!, 'proxy-test')).toEqual(['svc-a', 'svc-b']);
  });

  it("toggles addons and generates channel secrets when enabling channel addons", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'addons', 'chat');
    const automationsDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services:\n  chat:\n    image: test\n    environment:\n      CHANNEL_NAME: "Chat"\n      CHANNEL_ID: "chat"\n');
    writeFileSync(join(addonDir, '.env.schema'), 'CHANNEL_CHAT_SECRET=\n');
    writeFileSync(join(automationsDir, 'cleanup.md'), '---\ndescription: Cleanup\nschedule: "0 3 * * *"\ncommand: ["echo","clean"]\n---\n');

    materializeRegistryCatalog(sourceRoot);

    expect(setAddonEnabled(process.env.OP_HOME!, join(process.env.OP_HOME!, 'config', 'stack'), 'chat', true)).toEqual({
      ok: true,
      enabled: true,
      changed: true,
      services: ['chat'],
    });
    expect(existsSync(join(process.env.OP_HOME!, 'config', 'stack', 'addons', 'chat', 'compose.yml'))).toBe(true);
    expect(readFileSync(join(process.env.OP_HOME!, 'config', 'stack', 'guardian.env'), 'utf-8')).toMatch(/CHANNEL_CHAT_SECRET=/);

    expect(setAddonEnabled(process.env.OP_HOME!, join(process.env.OP_HOME!, 'config', 'stack'), 'chat', false)).toEqual({
      ok: true,
      enabled: false,
      changed: true,
      services: ['chat'],
    });
    expect(existsSync(join(process.env.OP_HOME!, 'config', 'stack', 'addons', 'chat'))).toBe(false);
  });

  it("backs up OP_HOME without recursively copying backups", () => {
    mkdirSync(join(process.env.OP_HOME!, 'config'), { recursive: true });
    mkdirSync(join(process.env.OP_HOME!, 'backups', 'old-backup'), { recursive: true });
    writeFileSync(join(process.env.OP_HOME!, 'config', 'stack.yml'), 'llm: test\n');
    writeFileSync(join(process.env.OP_HOME!, 'backups', 'old-backup', 'marker.txt'), 'old\n');

    const backupDir = backupOpenPalmHome(process.env.OP_HOME!);

    expect(backupDir).not.toBeNull();
    expect(existsSync(join(backupDir!, 'config', 'stack.yml'))).toBe(true);
    expect(existsSync(join(backupDir!, 'backups'))).toBe(false);
  });

  it("writes backups under the provided homeDir even when OP_HOME points elsewhere", () => {
    const actualHome = join(tmpDir, 'actual-home');
    const otherHome = join(tmpDir, 'other-home');

    mkdirSync(join(actualHome, 'config'), { recursive: true });
    mkdirSync(join(otherHome, 'backups'), { recursive: true });
    writeFileSync(join(actualHome, 'config', 'stack.yml'), 'llm: local\n');

    process.env.OP_HOME = otherHome;

    const backupDir = backupOpenPalmHome(actualHome);

    expect(backupDir).not.toBeNull();
    expect(backupDir!.startsWith(join(actualHome, 'backups'))).toBe(true);
    expect(existsSync(join(backupDir!, 'config', 'stack.yml'))).toBe(true);
    expect(existsSync(join(otherHome, 'backups', 'config', 'stack.yml'))).toBe(false);
  });

  it("parses compose profiles + openpalm.profile.* labels per addon", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'addons', 'voice');
    const automationsDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(
      join(addonDir, 'compose.yml'),
      [
        'services:',
        '  voice:',
        '    profiles: [cpu]',
        '    image: openpalm/voice:cpu',
        '    labels:',
        '      openpalm.profile.label: CPU',
        '      openpalm.profile.default: "true"',
        '  voice-cuda:',
        '    profiles: [cuda]',
        '    image: openpalm/voice:cuda',
        '    labels:',
        '      openpalm.profile.label: NVIDIA',
        '      openpalm.profile.requires: nvidia-container-toolkit',
        '',
      ].join('\n'),
    );
    writeFileSync(join(addonDir, '.env.schema'), 'VOICE=\n');
    writeFileSync(join(automationsDir, 'cleanup.md'), '---\ndescription: Cleanup\nschedule: "0 3 * * *"\ncommand: ["echo","clean"]\n---\n');

    materializeRegistryCatalog(sourceRoot);

    const profiles = getAddonProfiles(process.env.OP_HOME!, 'voice');
    expect(profiles).toEqual([
      { id: 'cpu', services: ['voice'], label: 'CPU', default: true },
      { id: 'cuda', services: ['voice-cuda'], label: 'NVIDIA', requires: 'nvidia-container-toolkit' },
    ]);
  });

  it("round-trips addon profile selection through stack.env", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'addons', 'voice');
    const automationsDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services:\n  voice:\n    profiles: [cpu]\n    image: x\n');
    writeFileSync(join(addonDir, '.env.schema'), 'VOICE=\n');
    writeFileSync(join(automationsDir, 'cleanup.md'), '---\ndescription: Cleanup\nschedule: "0 3 * * *"\ncommand: ["echo","clean"]\n---\n');

    materializeRegistryCatalog(sourceRoot);

    const stackDir = join(process.env.OP_HOME!, 'config', 'stack');
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, 'stack.env'), '');

    expect(getAddonProfileSelection(stackDir, 'voice')).toBeNull();
    setAddonProfileSelection(stackDir, 'voice', 'cuda');
    expect(getAddonProfileSelection(stackDir, 'voice')).toBe('cuda');
    expect(readFileSync(join(stackDir, 'stack.env'), 'utf-8')).toContain('OP_VOICE_PROFILE=cuda');
  });

  it("installs and uninstalls automations through stash/tasks", () => {
    const sourceRoot = join(tmpDir, 'repo');
    const addonDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'addons', 'chat');
    const automationsDir = join(sourceRoot, '.openpalm', 'state', 'registry', 'automations');
    const configDir = join(process.env.OP_HOME!, 'config');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services: {}\n');
    writeFileSync(join(addonDir, '.env.schema'), 'CHANNEL_CHAT_SECRET=\n');
    writeFileSync(join(automationsDir, 'cleanup.md'), '---\ndescription: Cleanup\nschedule: "0 3 * * *"\ncommand: ["echo","clean"]\n---\n');

    materializeRegistryCatalog(sourceRoot);

    const stashDir = join(process.env.OP_HOME!, 'stash');
    expect(installAutomationFromRegistry('cleanup', stashDir)).toEqual({ ok: true });
    expect(readFileSync(join(stashDir, 'tasks', 'cleanup.md'), 'utf-8')).toContain('Cleanup');

    expect(uninstallAutomation('cleanup', stashDir)).toEqual({ ok: true });
    expect(existsSync(join(stashDir, 'tasks', 'cleanup.md'))).toBe(false);
  });
});

// ── Host capability probes ───────────────────────────────────────────

describe("getAddonProfileAvailability", () => {
  beforeEach(() => {
    __addonAvailabilityTestHooks.reset();
  });

  afterEach(() => {
    __addonAvailabilityTestHooks.reset();
  });

  it("returns available:true for the cpu profile (no host requirements)", async () => {
    const result = await getAddonProfileAvailability({ id: 'cpu' });
    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns available:true for unknown profile ids (no host-side gating)", async () => {
    const result = await getAddonProfileAvailability({ id: 'something-else' });
    expect(result.available).toBe(true);
  });

  it("caches the result across calls (probe runs only once)", async () => {
    const a = await getAddonProfileAvailability({ id: 'cpu' });
    const b = await getAddonProfileAvailability({ id: 'cpu' });
    expect(a).toBe(b); // same reference — cached
  });

  it("probes cuda: returns available:false on a host with no NVIDIA runtime / CDI", async () => {
    // This test runs on CI/dev machines without GPUs. We don't mock execFile;
    // we just assert the contract: when neither signal is present, the
    // reason mentions nvidia-container-toolkit. If a future GPU host runs
    // this test, the assertion still tolerates the success case.
    const result = await getAddonProfileAvailability({ id: 'cuda' });
    if (!result.available) {
      expect(result.reason).toContain('NVIDIA');
    } else {
      // Host genuinely has the runtime registered — accept it.
      expect(result.reason).toBeUndefined();
    }
  });

  it("probes rocm: returns available:false when /dev/kfd is missing", async () => {
    const result = await getAddonProfileAvailability({ id: 'rocm' });
    if (!result.available) {
      expect(result.reason).toContain('ROCm');
    } else {
      expect(result.reason).toBeUndefined();
    }
  });

  it("probes rocm: when devices exist, reports unpublished image distinctly from missing-device case", async () => {
    // On a host without /dev/kfd, we hit the device-missing branch and
    // get the "devices not present" copy. On a ROCm host, we'd fall
    // through to the manifest-inspect probe and (until 0.11.0-rocm6
    // ships) get the "image not published yet" copy. Both must mention
    // ROCm so operator-facing copy stays consistent.
    const result = await getAddonProfileAvailability({ id: 'rocm' });
    if (!result.available && existsSync('/dev/kfd') && existsSync('/dev/dri')) {
      expect(result.reason).toMatch(/image not published|CPU profile/i);
    }
    if (!result.available && !(existsSync('/dev/kfd') && existsSync('/dev/dri'))) {
      expect(result.reason).toMatch(/devices not present/i);
    }
  });
});

describe("execFileNoThrow (ENOENT capture)", () => {
  it("captures ENOENT for a missing binary as 'spawn <cmd> ENOENT' stderr", async () => {
    const result = await __addonAvailabilityTestHooks.execFileNoThrow(
      '/nonexistent/path/to/openpalm-test-no-such-binary-zzz',
      ['--help'],
      2_000,
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/ENOENT/);
    // When the binary is "docker", the synthetic stderr becomes
    // `spawn docker ENOENT: command not found` — that string matches the
    // translateDockerError regex `/spawn .*docker.*ENOENT/i` so the
    // operator gets actionable copy instead of "unknown error (no stderr)".
    expect(result.stderr).toMatch(/spawn\s+\S*\s*ENOENT/);
  });

  it("formats ENOENT for `docker` so translateDockerError can match it", async () => {
    // Use an absolute path that we know doesn't exist so the test is
    // deterministic regardless of whether docker is installed on the host.
    const result = await __addonAvailabilityTestHooks.execFileNoThrow(
      'docker-not-installed-zzz',
      ['info'],
      2_000,
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('spawn docker-not-installed-zzz ENOENT: command not found');
  });
});

describe("annotateAddonProfileAvailability", () => {
  beforeEach(() => {
    __addonAvailabilityTestHooks.reset();
  });

  afterEach(() => {
    __addonAvailabilityTestHooks.reset();
  });

  it("decorates each profile with available + optional reason", async () => {
    const out = await annotateAddonProfileAvailability([
      { id: 'cpu', services: ['voice'], label: 'CPU', default: true },
      { id: 'rocm', services: ['voice-rocm'], label: 'AMD' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe('cpu');
    expect(out[0]?.available).toBe(true);
    // Preserves original fields.
    expect(out[0]?.label).toBe('CPU');
    expect(out[0]?.default).toBe(true);
    expect(out[1]?.id).toBe('rocm');
    expect(typeof out[1]?.available).toBe('boolean');
  });

  it("does not mutate the input array", async () => {
    const input = [{ id: 'cpu', services: ['voice'] }];
    const before = JSON.parse(JSON.stringify(input));
    await annotateAddonProfileAvailability(input);
    expect(input).toEqual(before);
  });
});
