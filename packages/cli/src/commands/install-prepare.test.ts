// C3: `prepareInstallFiles` must seed the client build the SAME way it seeds
// the UI build — before this fix, the client artifact was never seeded at
// install (`seedClientBuild` was dead code, only ever fetched lazily at
// `openpalm ui serve` time), so an air-gapped/offline install never got one.
//
// Deliberately does NOT mock '@openpalm/lib': mock.module() replaces that
// module GLOBALLY for the rest of the `bun test` process (see
// commands/update.test.ts's comment on the same issue), and a partial
// replacement of functions like createState/classifyLocalInstall corrupts
// OTHER test files (e.g. admin.test.ts) that depend on the real ones —
// verified the hard way while writing this file. Only the two
// network/registry-touching seed functions (io.ts) and host probing
// (host-info.ts) are faked; everything else (createState,
// initializeStateSecrets, writeSystemEnv, ensureAkmUserEnv, ensureOpenCode*)
// runs for REAL against a throwaway temp OP_HOME.
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realIo from '../lib/io.ts';
import * as realHostInfo from '../lib/host-info.ts';

const moduleUrls = {
  io: new URL('../lib/io.ts', import.meta.url).href,
  hostInfo: new URL('../lib/host-info.ts', import.meta.url).href,
};
const installModuleUrl = new URL('./install.ts', import.meta.url).href;
const savedOpHome = { value: undefined as string | undefined };

afterEach(() => {
  mock.restore();
  // mock.module() persists past mock.restore() — re-point to the real
  // modules so these mocks don't leak into other CLI test files sharing the
  // same `bun test` process (see update.test.ts for the same pattern).
  mock.module(moduleUrls.io, () => ({ ...realIo }));
  mock.module(moduleUrls.hostInfo, () => ({ ...realHostInfo }));
  if (savedOpHome.value === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = savedOpHome.value;
});

describe('prepareInstallFiles', () => {
  test('seeds the client build alongside the UI build (C3)', async () => {
    const seeded: string[] = [];

    mock.module(moduleUrls.io, () => ({
      ...realIo, // ensureDirectoryTree/applyHomeSeed run for REAL (plain fs ops) so the
                 // real initializeStateSecrets/writeSystemEnv/ensureAkmUserEnv calls
                 // further down in prepareInstallFiles have the directories they need.
      seedUiBuild: async (channel: string) => { seeded.push(`ui:${channel}`); },
      seedClientBuild: async (channel: string) => { seeded.push(`client:${channel}`); },
      uiUpdateChannel: (version: string) => (version.includes('-') ? 'next' : 'latest'),
    }));
    mock.module(moduleUrls.hostInfo, () => ({
      detectHostInfo: async () => ({ platform: 'test' }),
    }));

    const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-c3-'));
    savedOpHome.value = process.env.OP_HOME;
    process.env.OP_HOME = homeDir;
    try {
      const { prepareInstallFiles } = await import(`${installModuleUrl}?t=${Math.random()}`);
      await prepareInstallFiles(
        homeDir, join(homeDir, 'config'), join(homeDir, 'data'), join(homeDir, 'work'), 'v0.13.0-beta.1',
      );

      expect(seeded).toContain('ui:next');
      expect(seeded).toContain('client:next');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('a client seed failure is non-fatal (matches the UI build seed contract)', async () => {
    const seeded: string[] = [];

    mock.module(moduleUrls.io, () => ({
      ...realIo,
      seedUiBuild: async () => { seeded.push('ui'); },
      seedClientBuild: async () => { throw new Error('network unreachable'); },
      uiUpdateChannel: () => 'latest',
    }));
    mock.module(moduleUrls.hostInfo, () => ({
      detectHostInfo: async () => ({ platform: 'test' }),
    }));

    const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-c3-'));
    savedOpHome.value = process.env.OP_HOME;
    process.env.OP_HOME = homeDir;
    try {
      const { prepareInstallFiles } = await import(`${installModuleUrl}?t=${Math.random()}`);
      // Must not throw/reject — a seed hiccup is non-fatal, the install
      // continues (proven by the REAL createState/initializeStateSecrets/
      // writeSystemEnv/ensureAkmUserEnv calls after it all completing).
      await prepareInstallFiles(
        homeDir, join(homeDir, 'config'), join(homeDir, 'data'), join(homeDir, 'work'), 'v0.13.0',
      );

      expect(seeded).toEqual(['ui']);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
