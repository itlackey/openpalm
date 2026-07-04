import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseComposeServices } from './compose-services.js';
import { discoverHomeBindMountSources } from './config-persistence.js';

describe('parseComposeServices', () => {
  test('parses short-form and long-form volume entries with correct shapes', () => {
    const yaml = [
      'services:',
      '  api:',
      '    profiles: ["addon.api.cpu"]',
      '    labels:',
      '      openpalm.profile.label: API',
      '    volumes:',
      '      - /op/home/knowledge/secrets/auth.json:/app/auth.json:ro',
      '      - type: bind',
      '        source: /op/home/data.v2',
      '        target: /data',
      '        bind:',
      '          create_host_path: true',
      '  named:',
      '    volumes:',
      '      - modelcache:/models',
    ].join('\n');

    const services = parseComposeServices(yaml);
    expect(services.map((s) => s.name).sort()).toEqual(['api', 'named']);

    const api = services.find((s) => s.name === 'api');
    expect(api?.profiles).toEqual(['addon.api.cpu']);
    expect(api?.labels['openpalm.profile.label']).toBe('API');

    // Short-form: source is the pre-`:` segment, no explicit type.
    const short = api?.volumes[0];
    expect(short?.source).toBe('/op/home/knowledge/secrets/auth.json');
    expect(short?.target).toBe('/app/auth.json');
    expect(short?.type).toBeUndefined();

    // Long-form: type/source/bind preserved, including a dotless-dot dir name.
    const long = api?.volumes[1];
    expect(long?.type).toBe('bind');
    expect(long?.source).toBe('/op/home/data.v2');
    expect(long?.bind?.createHostPath).toBe(true);

    // Named volume: source keeps the volume name (not a host path).
    const named = services.find((s) => s.name === 'named');
    expect(named?.volumes[0]?.source).toBe('modelcache');
  });

  test('returns [] when there is no services map', () => {
    expect(parseComposeServices('version: "3"')).toEqual([]);
  });
});

describe('discoverHomeBindMountSources classification', () => {
  let homeDir = '';

  afterEach(() => {
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    homeDir = '';
  });

  function makeState(dir: string) {
    return {
      homeDir: dir,
      configDir: join(dir, 'config'),
      stashDir: join(dir, 'knowledge'),
      workspaceDir: join(dir, 'workspace'),
      dataDir: join(dir, 'data'),
      stackDir: join(dir, 'system', 'stack'),
      services: {},
      artifacts: { compose: '' },
      artifactMeta: [],
    };
  }

  test('long-form bind mount to a dotted dir name is a directory, not a file', () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-compose-'));
    const state = makeState(homeDir);
    mkdirSync(join(homeDir, 'system', 'stack'), { recursive: true });
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    writeFileSync(join(homeDir, 'knowledge', 'env', 'stack.env'), `OP_HOME=${homeDir}\n`);
    writeFileSync(
      join(homeDir, 'system', 'stack', 'services.compose.yml'),
      [
        'services:',
        '  db:',
        '    volumes:',
        '      - type: bind',
        `        source: ${homeDir}/data.v2`,
        '        target: /var/lib/db',
        '        bind:',
        '          create_host_path: true',
      ].join('\n'),
    );

    const mounts = discoverHomeBindMountSources(state);
    const dotted = mounts.find((m) => m.path.endsWith('/data.v2'));
    expect(dotted).toBeDefined();
    // A dotted directory name (data.v2) must NOT be misclassified as a file
    // just because the basename contains a dot — the long-form `type: bind`
    // tells us it is a directory target.
    expect(dotted?.isFile).toBe(false);
  });

  test('short-form file mount stays a file via the fallback heuristic', () => {
    homeDir = mkdtempSync(join(tmpdir(), 'openpalm-compose-'));
    const state = makeState(homeDir);
    mkdirSync(join(homeDir, 'system', 'stack'), { recursive: true });
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    writeFileSync(join(homeDir, 'knowledge', 'env', 'stack.env'), `OP_HOME=${homeDir}\n`);
    writeFileSync(
      join(homeDir, 'system', 'stack', 'core.compose.yml'),
      [
        'services:',
        '  assistant:',
        '    volumes:',
        `      - ${homeDir}/knowledge/secrets/auth.json:/app/auth.json`,
        `      - ${homeDir}/data/cache:/cache`,
      ].join('\n'),
    );

    const mounts = discoverHomeBindMountSources(state);
    expect(mounts.find((m) => m.path.endsWith('/auth.json'))?.isFile).toBe(true);
    // Dotless directory short-form: heuristic already treats it as a dir.
    expect(mounts.find((m) => m.path.endsWith('/data/cache'))?.isFile).toBe(false);
  });
});
