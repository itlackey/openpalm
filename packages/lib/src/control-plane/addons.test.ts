import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupOpenPalmHome } from './backup.js';
import {
  __addonAvailabilityTestHooks,
  annotateAddonProfileAvailability,
  getAddonProfileAvailability,
  getAddonProfileSelection,
  getAddonProfiles,
  getAddonServiceNames,
  getRegistryAddonConfig,
  getRegistryAutomation,
  installAutomationFromRegistry,
  listAvailableAddonIds,
  listEnabledAddonIds,
  setAddonEnabled,
  setAddonProfileSelection,
  uninstallAutomation,
} from './addons.js';
import { readSecret } from './secrets-files.js';

let tempDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = join(tempDir, 'home');
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
  __addonAvailabilityTestHooks.reset();
});

describe('builtin addon metadata', () => {
  it('returns static built-in addon ids', () => {
    // Canonical list from BUILTIN_ADDON_IDS (addon-ids.ts — single source of truth).
    // chat, gateway, ssh were previously missing from BUILTIN_ADDONS in addons.ts
    // but present in KNOWN_ADDON_IDS in migrations.ts; H6 unified them.
    expect(listAvailableAddonIds()).toEqual(['api', 'chat', 'discord', 'gateway', 'ollama', 'slack', 'ssh', 'voice']);
  });

  it('returns built-in addon schemas without registry materialization', () => {
    const discord = getRegistryAddonConfig('discord');
    const slack = getRegistryAddonConfig('slack');
    const ollama = getRegistryAddonConfig('ollama');

    expect(discord.userEnvPath).toBe('knowledge/env/stack.env');
    expect(discord.envSchema).toContain('DISCORD_BOT_TOKEN');
    expect(discord.envSchema).not.toContain('DISCORD_CUSTOM_COMMANDS');
    expect(slack.envSchema).not.toContain('SLACK_THREAD_TTL_HOURS');
    expect(slack.envSchema).not.toContain('SLACK_FORWARD_TIMEOUT_MS');
    expect(ollama.envSchema).toBe('');
    expect(getRegistryAddonConfig('ollama').envSchema).toBe('');
  });

  it('reads the bundled akm-improve automation', () => {
    expect(getRegistryAutomation('akm-improve')).toContain('akm improve');
  });
});

describe('addon runtime state', () => {
  it('ignores COMPOSE_PROFILES when resolving enabled addons', () => {
    const envDir = join(process.env.OP_HOME!, 'knowledge', 'env');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'stack.env'), 'COMPOSE_PROFILES=addon.chat\n');

    expect(listEnabledAddonIds(process.env.OP_HOME!)).toEqual([]);
  });

  it('treats canonical hardware profile selections as addon enablement', () => {
    const envDir = join(process.env.OP_HOME!, 'knowledge', 'env');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'stack.env'), 'OP_VOICE_PROFILE=addon.voice.cuda\n');

    expect(listEnabledAddonIds(process.env.OP_HOME!)).toEqual(['voice']);
  });

  it('returns addon service names from fixed compose files', () => {
    const stackDir = join(process.env.OP_HOME!, 'config', 'stack');
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, 'custom.compose.yml'), 'services:\n  proxy-test:\n    profiles: ["addon.proxy-test"]\n    image: image-a\n  proxy-test-worker:\n    profiles: ["addon.proxy-test"]\n    image: image-b\n');

    expect(getAddonServiceNames(process.env.OP_HOME!, 'proxy-test')).toEqual(['proxy-test', 'proxy-test-worker']);
  });

  it('toggles addons and generates channel secrets for channel addons', () => {
    const stackDir = join(process.env.OP_HOME!, 'config', 'stack');
    mkdirSync(stackDir, { recursive: true });

    const enabled = setAddonEnabled(process.env.OP_HOME!, 'discord', true);
    expect(enabled.ok).toBe(true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.changed).toBe(true);
    expect(enabled.services).toEqual(expect.arrayContaining(['guardian']));
    expect(listEnabledAddonIds(process.env.OP_HOME!)).toEqual(['discord']);
    expect(readSecret(process.env.OP_HOME!, 'portal_discord_secret')).toBeTruthy();

    const disabled = setAddonEnabled(process.env.OP_HOME!, 'discord', false);
    expect(disabled.ok).toBe(true);
    expect(disabled.enabled).toBe(false);
    expect(disabled.changed).toBe(true);
    expect(disabled.services).toEqual(expect.arrayContaining(['guardian']));
    expect(listEnabledAddonIds(process.env.OP_HOME!)).toEqual([]);
  });

  it('reads bundled addon profiles from the shipped compose assets', () => {
    expect(getAddonProfiles(process.env.OP_HOME!, 'voice')).toEqual([
      { id: 'addon.voice.cpu', services: ['voice'], label: 'CPU', default: true },
      { id: 'addon.voice.cuda', services: ['voice-cuda'], label: 'NVIDIA (CUDA 12.1)', requires: 'nvidia-container-toolkit' },
      { id: 'addon.voice.rocm', services: ['voice-rocm'], label: 'AMD (ROCm 6.x)', requires: 'amdgpu kernel module' },
    ]);
  });

  it('round-trips addon profile selection through stack.env', () => {
    const stackDir = join(process.env.OP_HOME!, 'config', 'stack');
    const stackEnv = join(process.env.OP_HOME!, 'knowledge', 'env', 'stack.env');
    mkdirSync(stackDir, { recursive: true });
    mkdirSync(join(process.env.OP_HOME!, 'knowledge', 'env'), { recursive: true });
    writeFileSync(stackEnv, '');

    expect(getAddonProfileSelection(process.env.OP_HOME!, 'voice')).toBeNull();
    setAddonProfileSelection(process.env.OP_HOME!, 'voice', 'addon.voice.cuda');
    expect(getAddonProfileSelection(process.env.OP_HOME!, 'voice')).toBe('addon.voice.cuda');
    expect(readFileSync(stackEnv, 'utf-8')).toContain('OP_VOICE_PROFILE=addon.voice.cuda');
  });
});

describe('automation install helpers', () => {
  it('installs and uninstalls automations through knowledge/tasks', () => {
    const stashDir = join(process.env.OP_HOME!, 'knowledge');
    expect(installAutomationFromRegistry('akm-improve', stashDir)).toEqual({ ok: true });
    expect(readFileSync(join(stashDir, 'tasks', 'akm-improve.yml'), 'utf-8')).toContain('akm improve');

    expect(uninstallAutomation('akm-improve', stashDir)).toEqual({ ok: true });
    expect(existsSync(join(stashDir, 'tasks', 'akm-improve.yml'))).toBe(false);
  });
});

describe('backup helpers', () => {
  it('backs up OP_HOME without recursively copying backups', () => {
    mkdirSync(join(process.env.OP_HOME!, 'config'), { recursive: true });
    mkdirSync(join(process.env.OP_HOME!, 'data', 'backups', 'old-backup'), { recursive: true });
    writeFileSync(join(process.env.OP_HOME!, 'config', 'stack.yml'), 'llm: test\n');
    writeFileSync(join(process.env.OP_HOME!, 'data', 'backups', 'old-backup', 'marker.txt'), 'old\n');

    const backupDir = backupOpenPalmHome(process.env.OP_HOME!);

    expect(backupDir).not.toBeNull();
    expect(existsSync(join(backupDir!, 'config', 'stack.yml'))).toBe(true);
    expect(existsSync(join(backupDir!, 'cache'))).toBe(false);
    expect(existsSync(join(backupDir!, 'data', 'backups'))).toBe(false);
  });

  it('writes backups under the provided homeDir even when OP_HOME points elsewhere', () => {
    const actualHome = join(tempDir, 'actual-home');
    const otherHome = join(tempDir, 'other-home');

    mkdirSync(join(actualHome, 'config'), { recursive: true });
    mkdirSync(join(otherHome, 'data', 'backups'), { recursive: true });
    writeFileSync(join(actualHome, 'config', 'stack.yml'), 'llm: local\n');

    process.env.OP_HOME = otherHome;

    const backupDir = backupOpenPalmHome(actualHome);

    expect(backupDir).not.toBeNull();
    expect(backupDir!.startsWith(join(actualHome, 'data', 'backups'))).toBe(true);
    expect(existsSync(join(backupDir!, 'config', 'stack.yml'))).toBe(true);
    expect(existsSync(join(otherHome, 'data', 'backups', 'config', 'stack.yml'))).toBe(false);
  });
});

describe('getAddonProfileAvailability', () => {
  it('returns available:true for the cpu profile', async () => {
    const result = await getAddonProfileAvailability({ id: 'addon.voice.cpu' });
    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns available:true for unknown profile ids', async () => {
    const result = await getAddonProfileAvailability({ id: 'something-else' });
    expect(result.available).toBe(true);
  });

  it('caches the result across calls', async () => {
    const a = await getAddonProfileAvailability({ id: 'addon.voice.cpu' });
    const b = await getAddonProfileAvailability({ id: 'addon.voice.cpu' });
    expect(a).toBe(b);
  });

  it('probes cuda conservatively', async () => {
    const result = await getAddonProfileAvailability({ id: 'addon.voice.cuda' });
    if (!result.available) expect(result.reason).toContain('NVIDIA');
    else expect(result.reason).toBeUndefined();
  });

  it('probes rocm conservatively', async () => {
    const result = await getAddonProfileAvailability({ id: 'addon.voice.rocm' });
    if (!result.available) expect(result.reason).toContain('ROCm');
    else expect(result.reason).toBeUndefined();
  });
});

describe('execFileNoThrow (ENOENT capture)', () => {
  it('captures ENOENT for a missing binary', async () => {
    const result = await __addonAvailabilityTestHooks.execFileNoThrow(
      '/nonexistent/path/to/openpalm-test-no-such-binary-zzz',
      ['--help'],
      2_000,
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/ENOENT/);
    expect(result.stderr).toMatch(/spawn\s+\S*\s*ENOENT/);
  });

  it('formats ENOENT for docker-style matching', async () => {
    const result = await __addonAvailabilityTestHooks.execFileNoThrow(
      'docker-not-installed-zzz',
      ['info'],
      2_000,
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('spawn docker-not-installed-zzz ENOENT: command not found');
  });
});

describe('annotateAddonProfileAvailability', () => {
  it('decorates each profile with availability metadata', async () => {
    const out = await annotateAddonProfileAvailability([
      { id: 'addon.voice.cpu', services: ['voice'], label: 'CPU', default: true },
      { id: 'addon.voice.rocm', services: ['voice-rocm'], label: 'AMD' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.available).toBe(true);
    expect(out[0]?.label).toBe('CPU');
    expect(out[1]?.id).toBe('addon.voice.rocm');
    expect(typeof out[1]?.available).toBe('boolean');
  });

  it('does not mutate the input array', async () => {
    const input = [{ id: 'addon.voice.cpu', services: ['voice'] }];
    const before = JSON.parse(JSON.stringify(input));
    await annotateAddonProfileAvailability(input);
    expect(input).toEqual(before);
  });
});
