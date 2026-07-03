import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverHomeBindMountSources } from './config-persistence.js';

let homeDir = '';

afterEach(() => {
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = '';
});

describe('discoverHomeBindMountSources', () => {
  test('preserves file mounts as files for precreation logic', () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-mounts-'));
    const state = {
      homeDir,
      configDir: join(homeDir, 'config'),
      stashDir: join(homeDir, 'knowledge'),
      workspaceDir: join(homeDir, 'workspace'),
      dataDir: join(homeDir, 'data'),
      stackDir: join(homeDir, 'system', 'stack'),
      services: {},
      artifacts: { compose: '' },
      artifactMeta: [],
    };

    mkdirSync(join(homeDir, 'system', 'stack'), { recursive: true });
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    writeFileSync(join(homeDir, 'knowledge', 'env', 'stack.env'), `OP_HOME=${homeDir}\n`);
    writeFileSync(join(homeDir, 'system', 'stack', 'core.compose.yml'), [
      'services:',
      '  assistant:',
      '    volumes:',
      `      - ${homeDir}/knowledge/secrets/auth.json:/home/opencode/.local/share/opencode/auth.json`,
    ].join('\n'));

    const mounts = discoverHomeBindMountSources(state);
    const authMount = mounts.find((mount) => mount.path.endsWith('/knowledge/secrets/auth.json'));
    expect(authMount).toBeDefined();
    expect(authMount?.isFile).toBe(true);
  });

  test('includes mounts from profiled services even when the profile is inactive', () => {
    // A disabled addon's empty dir costs nothing; a MISSING dir when the addon
    // is later enabled gets created root-owned by dockerd and the rootless
    // container EACCESes (issue #452). So discovery never filters by profile.
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-mounts-'));
    const state = {
      homeDir,
      configDir: join(homeDir, 'config'),
      stashDir: join(homeDir, 'knowledge'),
      workspaceDir: join(homeDir, 'workspace'),
      dataDir: join(homeDir, 'data'),
      stackDir: join(homeDir, 'system', 'stack'),
      services: {},
      artifacts: { compose: '' },
      artifactMeta: [],
    };

    mkdirSync(join(homeDir, 'system', 'stack'), { recursive: true });
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    writeFileSync(join(homeDir, 'knowledge', 'env', 'stack.env'), `OP_HOME=${homeDir}\n`);
    writeFileSync(join(homeDir, 'system', 'stack', 'services.compose.yml'), [
      'services:',
      '  voice:',
      '    profiles: ["addon.voice.cpu"]',
      '    volumes:',
      `      - ${homeDir}/data/voice/models:/models`,
    ].join('\n'));

    const mounts = discoverHomeBindMountSources(state);
    expect(mounts.find((mount) => mount.path.endsWith('/data/voice/models'))).toBeDefined();
  });
});
