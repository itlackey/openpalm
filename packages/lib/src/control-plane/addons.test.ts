import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupOpenPalmHome } from './backup.js';
import {
  annotateAddonProfileAvailability,
  getAddonProfileSelection,
  getAddonProfiles,
  getAddonServiceNames,
  getRegistryAddonConfig,
  getRegistryAutomation,
  installAutomationFromRegistry,
  listAvailableAddonIds,
  listEnabledAddonIds,
  migrateProfileOnlyAddonEnablement,
  pruneRemovedAddonState,
  setAddonEnabled,
  setAddonProfileSelection,
  uninstallAutomation,
} from './addons.js';
import {
  execFileNoThrow,
  getAddonProfileAvailability,
  resetAvailabilityCache,
  voiceImageRef,
} from './addon-availability.js';
import { readSecret } from './secrets-files.js';
import { remoteServeConfigDir } from './home.js';
import { patchStateEnvFile, readStackEnv } from './secrets.js';
import { resolveServeConfig } from './remote-access.js';
import { readRemoteAccessState, writeServeConfig } from './remote-apply.js';

let tempDir = '';
let homeDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  originalHome = process.env.OP_HOME;
  homeDir = join(tempDir, 'home');
  process.env.OP_HOME = homeDir;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
  resetAvailabilityCache();
});

describe('builtin addon metadata', () => {
  it('returns static built-in addon ids', () => {
    // Canonical list from BUILTIN_ADDON_IDS (addon-ids.ts — single source of truth).
    // `chat` is gone: it deployed nothing of its own, and the guardian now has
    // its own bare `guardian` profile for non-addon deploy reasons.
    expect(listAvailableAddonIds()).toEqual(['api', 'discord', 'gateway', 'ollama', 'paperclip', 'remote', 'slack', 'voice']);
  });

  it('returns built-in addon schemas without registry materialization', () => {
    const discord = getRegistryAddonConfig('discord');
    const slack = getRegistryAddonConfig('slack');
    const ollama = getRegistryAddonConfig('ollama');

    expect(discord.userEnvPath).toBe('state/stack.env');
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
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'stack.env'), 'COMPOSE_PROFILES=addon.gateway\n');

    expect(listEnabledAddonIds(homeDir)).toEqual([]);
  });

  it('a hardware profile var alone no longer enables an addon (reverse-parse deleted; migration owns it)', () => {
    // Plan 2.2: OP_ENABLED_ADDONS is the SOLE source of enablement. A profile
    // var (OP_VOICE_PROFILE) no longer implies enablement at READ time — the
    // one-time migrateProfileOnlyAddonEnablement persists it instead.
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_VOICE_PROFILE=addon.voice.cuda\n');

    expect(listEnabledAddonIds(homeDir)).toEqual([]);
  });

  it('returns addon service names from fixed compose files', () => {
    // custom.compose.yml is USER-owned → config/stack, not system/stack.
    const stackDir = join(homeDir, 'config', 'stack');
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, 'custom.compose.yml'), 'services:\n  proxy-test:\n    profiles: ["addon.proxy-test"]\n    image: image-a\n  proxy-test-worker:\n    profiles: ["addon.proxy-test"]\n    image: image-b\n');

    expect(getAddonServiceNames(homeDir, 'proxy-test')).toEqual(['proxy-test', 'proxy-test-worker']);
  });

  it('discovers and enables Paperclip through the generic addon path', () => {
    const stackDir = join(homeDir, 'system', 'stack');
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, 'services.compose.yml'), [
      'services:',
      '  paperclip:',
      '    profiles: [addon.paperclip]',
      '',
    ].join('\n'));

    expect(getAddonProfiles(homeDir, 'paperclip').map((profile) => profile.id)).toEqual(['addon.paperclip']);
    expect(setAddonEnabled(homeDir, 'paperclip', true)).toEqual({
      ok: true,
      enabled: true,
      changed: true,
      services: ['paperclip'],
    });
    expect(listEnabledAddonIds(homeDir)).toContain('paperclip');
    const paperclipEnv = join(homeDir, 'private', 'env', 'paperclip.env');
    expect(existsSync(paperclipEnv)).toBe(true);

    writeFileSync(
      paperclipEnv,
      'BETTER_AUTH_SECRET=auth\nPAPERCLIP_TOOL_ACTION_SIGNING_SECRET=legacy\n',
    );
    expect(setAddonEnabled(homeDir, 'paperclip', true)).toEqual({
      ok: true,
      enabled: true,
      changed: false,
      services: ['paperclip'],
    });
    expect(readFileSync(paperclipEnv, 'utf8')).toBe(
      'BETTER_AUTH_SECRET=auth\nPAPERCLIP_AGENT_JWT_SECRET=legacy\n',
    );
  });

  it('toggles addons and generates channel secrets for channel addons', () => {
    const stackDir = join(homeDir, 'system', 'stack');
    mkdirSync(stackDir, { recursive: true });

    const enabled = setAddonEnabled(homeDir, 'discord', true);
    expect(enabled.ok).toBe(true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.changed).toBe(true);
    expect(enabled.services).toEqual(expect.arrayContaining(['guardian']));
    expect(listEnabledAddonIds(homeDir)).toEqual(['discord']);
    expect(readSecret(homeDir, 'portal_discord_secret')).toBeTruthy();

    const disabled = setAddonEnabled(homeDir, 'discord', false);
    expect(disabled.ok).toBe(true);
    expect(disabled.enabled).toBe(false);
    expect(disabled.changed).toBe(true);
    expect(disabled.services).toEqual(expect.arrayContaining(['guardian']));
    expect(listEnabledAddonIds(homeDir)).toEqual([]);
  });

  // The `remote` addon's container serves a GENERATED document, so recording
  // enablement is not an apply on its own — setAddonEnabled has to run the
  // full remote apply inline or the CLI/UI toggle starts a tunnel reading the
  // PREVIOUS document (enable serving nothing) and leaves a live one behind
  // on disable.
  describe('remote addon toggling', () => {
    function serveDoc(): unknown {
      return JSON.parse(readFileSync(join(remoteServeConfigDir(homeDir), 'serve.json'), 'utf-8'));
    }

    it('writes the live serve document when remote is enabled', () => {
      const result = setAddonEnabled(homeDir, 'remote', true);

      expect(result.ok).toBe(true);
      expect(serveDoc()).toEqual(resolveServeConfig(readRemoteAccessState(homeDir).config));
      expect(result.services).toEqual(expect.arrayContaining(['tunnel']));
    });

    it('retries a failed remote apply when the addon is already in the requested state', () => {
      const staleConfig = { hostname: 'stale', public: true, target: 'assistant' } as const;
      writeServeConfig(homeDir, staleConfig);
      const servePath = join(remoteServeConfigDir(homeDir), 'serve.json');
      mkdirSync(`${servePath}.tmp`);

      const first = setAddonEnabled(homeDir, 'remote', true);

      expect(first.ok).toBe(false);
      expect(listEnabledAddonIds(homeDir)).toContain('remote');
      expect(serveDoc()).toEqual(resolveServeConfig(staleConfig));

      rmSync(`${servePath}.tmp`, { recursive: true, force: true });
      const retry = setAddonEnabled(homeDir, 'remote', true);

      expect(retry).toEqual(expect.objectContaining({ ok: true, enabled: true, changed: false }));
      expect(serveDoc()).toEqual(resolveServeConfig(readRemoteAccessState(homeDir).config));
    });

    // The fail-closed property: the empty document is on disk BEFORE the
    // caller stops any container, so a `compose stop` that fails afterwards
    // cannot leave a Funnel publicly reachable.
    it('writes the disabled serve document when remote is disabled', () => {
      setAddonEnabled(homeDir, 'remote', true);
      expect(serveDoc()).not.toEqual({ TCP: {}, Web: {}, AllowFunnel: {} });

      const result = setAddonEnabled(homeDir, 'remote', false);

      expect(result.ok).toBe(true);
      expect(serveDoc()).toEqual({ TCP: {}, Web: {}, AllowFunnel: {} });
    });

    it('turns on guardian ingress and recreates guardian for a guardian target', () => {
      patchStateEnvFile(homeDir, { OP_REMOTE_TARGET: 'guardian' });
      setAddonEnabled(homeDir, 'gateway', true);

      const result = setAddonEnabled(homeDir, 'remote', true);

      expect(result.ok).toBe(true);
      expect(readStackEnv(homeDir).GUARDIAN_DIRECT_INGRESS).toBe('true');
      expect(result.services).toEqual(expect.arrayContaining(['tunnel', 'guardian']));
    });

    it('does not warn on a guardian target with no ingress addon — the remote reason itself deploys the guardian', () => {
      patchStateEnvFile(homeDir, { OP_REMOTE_TARGET: 'guardian' });

      const result = setAddonEnabled(homeDir, 'remote', true);

      expect(result.ok).toBe(true);
      // A remote tunnel targeting the guardian is a guardianRequired reason
      // (guardian-required.ts): the bare `guardian` compose profile is active,
      // so there is no "enable an ingress addon" gap left to warn about.
      expect(result.warning).toBeUndefined();
      expect(readStackEnv(homeDir).GUARDIAN_DIRECT_INGRESS).toBe('true');
      expect(result.services).toEqual(expect.arrayContaining(['tunnel', 'guardian']));
    });

    it('leaves other addons untouched by the remote apply', () => {
      const result = setAddonEnabled(homeDir, 'voice', true);

      expect(result.ok).toBe(true);
      expect(result.warning).toBeUndefined();
      // voice must not drag the remote serve document into existence.
      expect(existsSync(join(remoteServeConfigDir(homeDir), 'serve.json'))).toBe(false);
    });
  });

  // PR #564 second retest R6: disabling a profile-bearing addon must clear its
  // hardware-profile env key, or migrateProfileOnlyAddonEnablement re-derives the
  // addon from the lingering profile and silently re-enables it.
  it('clears OP_VOICE_PROFILE when voice is disabled, so a later migration does not re-enable it', () => {
    setAddonEnabled(homeDir, 'voice', true);
    setAddonProfileSelection(homeDir, 'voice', 'addon.voice.cuda');
    expect(listEnabledAddonIds(homeDir)).toContain('voice');
    expect(getAddonProfileSelection(homeDir, 'voice')).toBeTruthy();

    const disabled = setAddonEnabled(homeDir, 'voice', false);
    expect(disabled.ok).toBe(true);
    expect(listEnabledAddonIds(homeDir)).not.toContain('voice');
    // The profile key is gone …
    expect(getAddonProfileSelection(homeDir, 'voice')).toBeNull();

    // … so the profile-only migration has nothing to re-derive and voice stays off.
    const migration = migrateProfileOnlyAddonEnablement(homeDir);
    expect(migration.migratedAddons).not.toContain('voice');
    expect(listEnabledAddonIds(homeDir)).not.toContain('voice');
  });

  it('reads bundled addon profiles from the shipped compose assets', () => {
    expect(getAddonProfiles(homeDir, 'voice')).toEqual([
      { id: 'addon.voice.cpu', services: ['voice'], label: 'CPU', default: true },
      { id: 'addon.voice.cuda', services: ['voice-cuda'], label: 'NVIDIA (CUDA 12.1)', requires: 'nvidia-container-toolkit' },
      { id: 'addon.voice.rocm', services: ['voice-rocm'], label: 'AMD (ROCm 6.x)', requires: 'amdgpu kernel module' },
    ]);
  });

  it('round-trips addon profile selection through state/stack.env (constitution §1)', () => {
    const stackDir = join(homeDir, 'system', 'stack');
    const stackEnv = join(homeDir, 'state', 'stack.env');
    const stateEnv = join(homeDir, 'state', 'stack.env');
    mkdirSync(stackDir, { recursive: true });
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(stackEnv, '');

    expect(getAddonProfileSelection(homeDir, 'voice')).toBeNull();
    setAddonProfileSelection(homeDir, 'voice', 'addon.voice.cuda');
    expect(getAddonProfileSelection(homeDir, 'voice')).toBe('addon.voice.cuda');
    // App-written addon state lands in the single state/stack.env.
    expect(readFileSync(stateEnv, 'utf-8')).toContain('OP_VOICE_PROFILE=addon.voice.cuda');
  });
});

describe('removed-addon state cleanup (R8: stale ssh)', () => {
  function seedStateEnv(contents: string): string {
    const stateEnv = join(homeDir, 'state', 'stack.env');
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(stateEnv, contents);
    return stateEnv;
  }

  it('strips a lingering ssh addon and OPENCODE_ENABLE_SSH from an upgraded install', () => {
    const stateEnv = seedStateEnv('OP_ENABLED_ADDONS=ssh,voice\nOPENCODE_ENABLE_SSH=1\n');

    // ssh is no longer built in, so it is hidden from the effective set but
    // still present in the raw env until pruned.
    expect(listEnabledAddonIds(homeDir)).toEqual(['voice']);
    expect(readFileSync(stateEnv, 'utf-8')).toContain('ssh');

    const result = pruneRemovedAddonState(homeDir);
    expect(result.changed).toBe(true);
    expect(result.removedAddons).toEqual(['ssh']);
    expect(result.removedEnvKeys).toEqual(['OPENCODE_ENABLE_SSH']);

    const after = readFileSync(stateEnv, 'utf-8');
    expect(after).toContain('OP_ENABLED_ADDONS=voice');
    expect(after).not.toContain('ssh');
    expect(after).not.toContain('OPENCODE_ENABLE_SSH');
  });

  it('strips retired OP_TTS_*/OP_STT_* host voice-config keys from stack.env', () => {
    const legacyEnv = seedStateEnv(
      'OP_ENABLED_ADDONS=voice\n' +
        'OP_ASSISTANT_PORT=3800\n\n' +
        '# ── Voice Channel (TTS/STT) ──────────────────────────────────────────\n' +
        'OP_TTS_ENGINE=openpalm-voice\nOP_TTS_BASE_URL=http://127.0.0.1:8880\nOP_TTS_MODEL=kokoro\nOP_TTS_VOICE=bf_isabella\n' +
        'OP_STT_ENGINE=openpalm-voice\nOP_STT_BASE_URL=http://127.0.0.1:8880\nOP_STT_MODEL=whisper-1\nOP_STT_LANGUAGE=en\n'
    );

    const result = pruneRemovedAddonState(homeDir);
    expect(result.changed).toBe(true);
    expect(result.removedEnvKeys).toEqual(
      expect.arrayContaining(['OP_TTS_ENGINE', 'OP_TTS_BASE_URL', 'OP_STT_MODEL', 'OP_STT_LANGUAGE'])
    );

    const after = readFileSync(legacyEnv, 'utf-8');
    expect(after).toContain('OP_ASSISTANT_PORT=3800');
    expect(after).not.toContain('OP_TTS_');
    expect(after).not.toContain('OP_STT_');
    // The now-empty section header goes with its keys.
    expect(after).not.toContain('Voice Channel');
    // The voice ADDON stays enabled — only the retired provider config goes.
    expect(listEnabledAddonIds(homeDir)).toEqual(['voice']);
  });

  it('is idempotent — a second prune is a no-op that writes nothing', () => {
    seedStateEnv('OP_ENABLED_ADDONS=ssh\nOPENCODE_ENABLE_SSH=1\n');
    expect(pruneRemovedAddonState(homeDir).changed).toBe(true);

    const stateEnv = join(homeDir, 'state', 'stack.env');
    const contentAfterFirst = readFileSync(stateEnv, 'utf-8');
    const second = pruneRemovedAddonState(homeDir);
    expect(second.changed).toBe(false);
    expect(second.removedAddons).toEqual([]);
    expect(second.removedEnvKeys).toEqual([]);
    expect(readFileSync(stateEnv, 'utf-8')).toBe(contentAfterFirst);
  });

  it('leaves a clean install untouched (skip-if-absent no-op)', () => {
    const stateEnv = seedStateEnv('OP_ENABLED_ADDONS=voice\n');
    const before = readFileSync(stateEnv, 'utf-8');

    const result = pruneRemovedAddonState(homeDir);
    expect(result).toEqual({ changed: false, removedAddons: [], removedEnvKeys: [] });
    expect(readFileSync(stateEnv, 'utf-8')).toBe(before);
  });

  it('is a no-op when there is no state env at all', () => {
    const result = pruneRemovedAddonState(homeDir);
    expect(result.changed).toBe(false);
  });

  it('disables a lingering ssh entry via setAddonEnabled', () => {
    const stateEnv = seedStateEnv('OP_ENABLED_ADDONS=ssh,voice\nOPENCODE_ENABLE_SSH=1\n');

    const disabled = setAddonEnabled(homeDir, 'ssh', false);
    expect(disabled.ok).toBe(true);
    if (disabled.ok) expect(disabled.changed).toBe(true);

    const after = readFileSync(stateEnv, 'utf-8');
    expect(after).toContain('OP_ENABLED_ADDONS=voice');
    expect(after).not.toContain('ssh');
    expect(after).not.toContain('OPENCODE_ENABLE_SSH');
  });

  it('still rejects ENABLING a non-built-in addon (validation unchanged)', () => {
    const result = setAddonEnabled(homeDir, 'ssh', true);
    expect(result).toEqual({ ok: false, error: 'Addon "ssh" is not built in' });
  });

  it('treats disabling an absent removed addon as a no-op success', () => {
    seedStateEnv('OP_ENABLED_ADDONS=voice\n');
    const result = setAddonEnabled(homeDir, 'ssh', false);
    expect(result).toEqual({ ok: true, enabled: false, changed: false, services: [] });
  });
});

describe('profile-only addon enablement migration (2.2 R2-R8 upgrade guard)', () => {
  it('upgrade path: an install that only ever set OP_VOICE_PROFILE (never OP_ENABLED_ADDONS) keeps voice enabled after migration', () => {
    // Simulate a pre-existing install that enabled voice ONLY by picking a
    // hardware profile (e.g. via the old wizard flow) — OP_ENABLED_ADDONS was
    // never written. With the READ-time reverse-parse now deleted (plan 2.2),
    // such an install would silently LOSE voice on upgrade — until the
    // migration persists the derived id into OP_ENABLED_ADDONS.
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_VOICE_PROFILE=addon.voice.cuda\n');

    // Before the migration the addon is NOT enabled (the upgrade hazard).
    expect(listEnabledAddonIds(homeDir)).toEqual([]);

    const result = migrateProfileOnlyAddonEnablement(homeDir);
    expect(result.changed).toBe(true);
    expect(result.migratedAddons).toEqual(['voice']);

    // The addon id must now be durably recorded in OP_ENABLED_ADDONS (state/),
    // NOT only derivable via the reverse-parse — so it survives even after the
    // reverse-parse is eventually deleted.
    const stateEnv = join(homeDir, 'state', 'stack.env');
    expect(readFileSync(stateEnv, 'utf-8')).toContain('OP_ENABLED_ADDONS=voice');
    expect(listEnabledAddonIds(homeDir)).toEqual(['voice']);
  });

  it('migrates OP_OLLAMA_PROFILE the same way', () => {
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_OLLAMA_PROFILE=addon.ollama.cpu\n');

    const result = migrateProfileOnlyAddonEnablement(homeDir);
    expect(result.changed).toBe(true);
    expect(result.migratedAddons).toEqual(['ollama']);
    const stateEnv = join(homeDir, 'state', 'stack.env');
    expect(readFileSync(stateEnv, 'utf-8')).toContain('OP_ENABLED_ADDONS=ollama');
  });

  it('is idempotent — a second migration pass is a no-op that writes nothing', () => {
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_VOICE_PROFILE=addon.voice.cpu\n');

    expect(migrateProfileOnlyAddonEnablement(homeDir).changed).toBe(true);
    const stateEnv = join(homeDir, 'state', 'stack.env');
    const contentAfterFirst = readFileSync(stateEnv, 'utf-8');

    const second = migrateProfileOnlyAddonEnablement(homeDir);
    expect(second.changed).toBe(false);
    expect(second.migratedAddons).toEqual([]);
    expect(readFileSync(stateEnv, 'utf-8')).toBe(contentAfterFirst);
  });

  it('is a no-op when OP_ENABLED_ADDONS already lists the addon', () => {
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'stack.env'), 'OP_VOICE_PROFILE=addon.voice.cuda\n');
    const stateEnv = join(homeDir, 'state', 'stack.env');
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(stateEnv, 'OP_ENABLED_ADDONS=voice\n');
    const before = readFileSync(stateEnv, 'utf-8');

    const result = migrateProfileOnlyAddonEnablement(homeDir);
    expect(result).toEqual({ changed: false, migratedAddons: [] });
    expect(readFileSync(stateEnv, 'utf-8')).toBe(before);
  });

  it('is a no-op on a fresh install with no profile vars set', () => {
    const result = migrateProfileOnlyAddonEnablement(homeDir);
    expect(result).toEqual({ changed: false, migratedAddons: [] });
  });
});

describe('automation install helpers', () => {
  it('installs and uninstalls automations through knowledge/tasks', () => {
    const stashDir = join(homeDir, 'knowledge');
    expect(installAutomationFromRegistry('akm-improve', stashDir)).toEqual({ ok: true });
    expect(readFileSync(join(stashDir, 'tasks', 'akm-improve.yml'), 'utf-8')).toContain('akm improve');

    expect(uninstallAutomation('akm-improve', stashDir)).toEqual({ ok: true });
    expect(existsSync(join(stashDir, 'tasks', 'akm-improve.yml'))).toBe(false);
  });
});

describe('backup helpers', () => {
  it('backs up config/state trees but EXCLUDES the regenerable data/ tree', () => {
    mkdirSync(join(homeDir, 'config'), { recursive: true });
    mkdirSync(join(homeDir, 'data', 'backups', 'old-backup'), { recursive: true });
    mkdirSync(join(homeDir, 'data', 'assistant'), { recursive: true });
    writeFileSync(join(homeDir, 'config', 'stack.yml'), 'llm: test\n');
    writeFileSync(join(homeDir, 'data', 'backups', 'old-backup', 'marker.txt'), 'old\n');
    writeFileSync(join(homeDir, 'data', 'assistant', 'cache.bin'), 'big\n');

    const backupDir = backupOpenPalmHome(homeDir);

    expect(backupDir).not.toBeNull();
    if (backupDir === null) return; // narrow for TS; the expect above already failed the test if null
    expect(existsSync(join(backupDir, 'config', 'stack.yml'))).toBe(true);
    expect(existsSync(join(backupDir, 'cache'))).toBe(false);
    // The whole data/ tree is excluded — it's large, regenerable runtime state
    // (this is the fix for snapshots ballooning to GBs and filling the disk).
    expect(existsSync(join(backupDir, 'data'))).toBe(false);
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
    if (backupDir === null) return; // narrow for TS; the expect above already failed the test if null
    expect(backupDir.startsWith(join(actualHome, 'data', 'backups'))).toBe(true);
    expect(existsSync(join(backupDir, 'config', 'stack.yml'))).toBe(true);
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

describe('voiceImageRef', () => {
  it('appends the hardware suffix to the configured base version', () => {
    const originalNamespace = process.env.OP_IMAGE_NAMESPACE;
    const originalVersion = process.env.OP_VOICE_VERSION;
    try {
      process.env.OP_IMAGE_NAMESPACE = 'example';
      process.env.OP_VOICE_VERSION = '1.2.3';
      expect(voiceImageRef('cu121')).toBe('example/voice:1.2.3-cu121');
    } finally {
      if (originalNamespace === undefined) delete process.env.OP_IMAGE_NAMESPACE;
      else process.env.OP_IMAGE_NAMESPACE = originalNamespace;
      if (originalVersion === undefined) delete process.env.OP_VOICE_VERSION;
      else process.env.OP_VOICE_VERSION = originalVersion;
    }
  });
});

describe('execFileNoThrow (ENOENT capture)', () => {
  it('captures ENOENT for a missing binary', async () => {
    const result = await execFileNoThrow(
      '/nonexistent/path/to/openpalm-test-no-such-binary-zzz',
      ['--help'],
      2_000,
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/ENOENT/);
    expect(result.stderr).toMatch(/spawn\s+\S*\s*ENOENT/);
  });

  it('formats ENOENT for docker-style matching', async () => {
    const result = await execFileNoThrow(
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
