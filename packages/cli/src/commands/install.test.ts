/**
 * `openpalm install` (and bare `openpalm` on a fresh machine) serves the setup
 * wizard. The wizard writes secrets and deploys the stack, so `/setup` and
 * `/api/setup/*` are gated on the `host:setup` capability, which only an
 * admin-capable UI process advertises.
 *
 * Shipping without that flag made the product's front door a closed loop: the
 * materialized-but-incomplete home made the UI redirect every navigation to
 * `/setup`, which the same non-admin process then answered 403
 * capability_not_available. The UI now refuses to redirect to a `/setup` it
 * cannot serve (hooks.server.setup-deadlock.vitest.ts), so this test pins the
 * other half — the wizard asks for a UI that can actually run it.
 *
 * Harness: real @openpalm/lib against a temp OP_HOME with the file-seeding and
 * Docker preflight stubbed out; `startUIServer` is replaced with a capture so
 * no server is started.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from 'citty';
import * as realLib from '../../../lib/src/index.ts';
import type { UIServerOptions } from '../lib/ui-server.ts';

const installModuleUrl = new URL('./install.ts', import.meta.url).href;
const uiServerModuleUrl = new URL('../lib/ui-server.ts', import.meta.url).href;

const originalWhich = Bun.which;
const originalSpawn = Bun.spawn;
const originalLog = console.log;
const savedHome = process.env.OP_HOME;
const tmpDirs: string[] = [];

afterEach(() => {
  mock.restore();
  Bun.which = originalWhich;
  Bun.spawn = originalSpawn;
  console.log = originalLog;
  if (savedHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = savedHome;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Docker preflight passes: `docker` resolves and every probe exits 0. */
function stubDockerPresent(): void {
  Bun.which = ((cmd: string) => (cmd === 'docker' ? '/usr/bin/docker' : null)) as typeof Bun.which;
  Bun.spawn = (() => ({ exited: Promise.resolve(0) })) as unknown as typeof Bun.spawn;
}

test('the setup wizard is served by an admin-capable UI process', async () => {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-install-wizard-'));
  tmpDirs.push(home);
  process.env.OP_HOME = home;
  stubDockerPresent();
  console.log = () => {};

  // Seeding the home is not under test — `applyHomeSeed`/`seedUiBuild` need a
  // release payload. Everything else runs for real against the temp home.
  mock.module('@openpalm/lib', () => ({
    ...realLib,
    applyHomeSeed: () => ({ seeded: [], skipped: [] }),
    seedUiBuild: () => {},
  }));

  const captured: UIServerOptions[] = [];
  mock.module(uiServerModuleUrl, () => ({
    startUIServer: async (opts: UIServerOptions) => {
      captured.push(opts);
    },
  }));

  const install = (await import(installModuleUrl)).default;
  await runCommand(install, { rawArgs: ['--no-open'] });

  expect(captured).toHaveLength(1);
  expect(captured[0]?.adminHostUi).toBe(true);
});
