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
 * cannot serve (hooks.server.setup-deadlock.vitest.ts); this pins the other
 * half — the wizard asks for a UI that can actually run it.
 *
 * Deliberately a unit test over the pure options builder. Driving the whole
 * `install` command means mutating the process-global OP_HOME, which races the
 * other files in the aggregate suite, and `defineAction` converts any resulting
 * error into `process.exit(1)` — taking the entire test run down with it.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realLib from '../../../lib/src/index.ts';
import * as realPrompt from '../lib/prompt.ts';
import { wizardUiServerOptions } from './install.ts';
import { DEFAULT_UI_PORT } from '../lib/ports.ts';

test('the setup wizard is served by an admin-capable UI process', () => {
  expect(wizardUiServerOptions(false, {}).adminHostUi).toBe(true);
});

test('--no-open is honored without weakening the admin capability', () => {
  const options = wizardUiServerOptions(true, {});
  expect(options.open).toBe(false);
  expect(options.adminHostUi).toBe(true);
});

test('the wizard port follows OP_HOST_UI_PORT, defaulting to the shared constant', () => {
  expect(wizardUiServerOptions(false, {}).port).toBe(DEFAULT_UI_PORT);
  expect(wizardUiServerOptions(false, { OP_HOST_UI_PORT: '4200' }).port).toBe(4200);
  // A non-numeric value must not produce NaN — startUIServer rejects that.
  expect(wizardUiServerOptions(false, { OP_HOST_UI_PORT: 'nope' }).port).toBe(DEFAULT_UI_PORT);
});

test('the wizard reads back a port a headless install persisted to stack.env', () => {
  // The options builder used to resolve from process.env ALONE. Because an
  // explicit `port` short-circuits resolveUiServePort, that made the wizard the
  // one serve entry that ignored a persisted OP_HOST_UI_PORT — it bound 3880 and
  // printed 3880 while every other entry on the same home used 4300.
  expect(wizardUiServerOptions(false, {}, { OP_HOST_UI_PORT: '4300' }).port).toBe(4300);
  // Live env still wins over the file, matching every other resolver.
  expect(
    wizardUiServerOptions(false, { OP_HOST_UI_PORT: '5000' }, { OP_HOST_UI_PORT: '4300' }).port,
  ).toBe(5000);
});

// ── bootstrapInstall: decline exit code + the seed-phase install lock ──────
//
// Unlike the pure-options tests above, these two DO drive bootstrapInstall
// directly (mirroring rollback.test.ts's runRollbackAction tests) — safely,
// because Docker and the install lock are mocked out (never a real `docker`
// call) and OP_HOME/mock.module state is saved and restored around each test.
const moduleUrls = {
  prompt: new URL('../lib/prompt.ts', import.meta.url).href,
};
const installModuleUrl = new URL('./install.ts', import.meta.url).href;

afterEach(() => {
  mock.restore();
  // mock.restore() does NOT undo mock.module(); re-point to the real modules
  // so these mocks do not leak into other test files in the shared bun test process.
  mock.module('@openpalm/lib', () => ({ ...realLib }));
  mock.module(moduleUrls.prompt, () => ({ ...realPrompt }));
});

/** Run `fn` with a fresh temp OP_HOME and process.stdin/stdout forced into TTY mode, restoring both afterward. */
async function withInteractiveTempHome(fn: (tempHome: string) => Promise<void>): Promise<void> {
  const savedHome = process.env.OP_HOME;
  const tempHome = mkdtempSync(join(tmpdir(), 'openpalm-install-test-'));
  process.env.OP_HOME = tempHome;
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    await fn(tempHome);
  } finally {
    if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
    else Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
    else Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    if (savedHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = savedHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
}

describe('bootstrapInstall — declined --force confirmation (C10/B8 exit-code fix)', () => {
  test('throws instead of silently returning, so the CLI exits non-zero', async () => {
    await withInteractiveTempHome(async () => {
      mock.module('@openpalm/lib', () => ({
        ...realLib,
        hasAnyStackEnvFile: () => true,
        hasMaterializedLocalInstall: () => false,
        ensureDockerReady: async () => ({ ok: true, message: '' }),
      }));
      mock.module(moduleUrls.prompt, () => ({
        promptYesNo: async () => false,
      }));

      const { bootstrapInstall } = await import(`${installModuleUrl}?t=${Math.random()}`);
      await expect(
        bootstrapInstall({ force: true, version: '1.0.0', noStart: false, noOpen: true, assumeYes: false }),
      ).rejects.toThrow(/Install aborted/);
    });
  });
});

describe('bootstrapInstall — seed-phase install lock (C10/B10)', () => {
  test('refuses with install_in_progress when the lock is already held, before any home seed write', async () => {
    await withInteractiveTempHome(async () => {
      let ensureHomeDirsCalled = false;
      mock.module('@openpalm/lib', () => ({
        ...realLib,
        hasAnyStackEnvFile: () => false,
        hasMaterializedLocalInstall: () => false,
        ensureDockerReady: async () => ({ ok: true, message: '' }),
        // Lock held by a concurrent install/update — acquire returns null.
        acquireInstallLock: () => null,
        releaseInstallLock: () => {},
        ensureHomeDirs: () => {
          ensureHomeDirsCalled = true;
        },
      }));

      const { bootstrapInstall } = await import(`${installModuleUrl}?t=${Math.random()}`);
      await expect(
        bootstrapInstall({ force: false, version: '1.0.0', noStart: false, noOpen: true, assumeYes: false }),
      ).rejects.toThrow(/install_in_progress/);
      expect(ensureHomeDirsCalled).toBe(false);
    });
  });
});

// ── #632: --no-start only has meaning on the --file path ───────────────────
//
// The wizard both configures (mints every secret) and deploys in one step —
// prepareInstallFiles deliberately never mints secrets (C1 in install.ts),
// because performSetup is documented as the sole minter. Silently honoring
// --no-start on the wizard path used to leave a compose-looking home with no
// secrets and nothing telling the operator, whose first symptom was an opaque
// Docker bind-source error at the next `docker compose up`. Fixes #632 for
// real, replacing the secret-audit existence-check band-aid (reverted).
describe('bootstrapInstall — --no-start requires --file (#632)', () => {
  test('rejects --no-start without --file, before anything touches OP_HOME', async () => {
    await withInteractiveTempHome(async (tempHome) => {
      mock.module('@openpalm/lib', () => ({
        ...realLib,
        hasAnyStackEnvFile: () => false,
        hasMaterializedLocalInstall: () => false,
        // Not reached once the guard fires — mocked only so this test stays
        // fast and deterministic if it is ever run against pre-fix code
        // (see the file-copy regression proof), where the real Docker probe
        // would otherwise run.
        ensureDockerReady: async () => ({ ok: false, message: 'mock: docker not reachable' }),
      }));

      const { bootstrapInstall } = await import(`${installModuleUrl}?t=${Math.random()}`);
      await expect(
        bootstrapInstall({ force: false, noStart: true, noOpen: true, assumeYes: false }),
      ).rejects.toThrow(
        '--no-start requires --file: the setup wizard configures and starts the stack in one ' +
          'step. For a non-interactive install that must not start containers, write a setup ' +
          'config and pass --file <path> --no-start (see docs/operations/manual-headless-install.md).',
      );

      // The guard runs before homeDir is even resolved, so a rejected call
      // must leave OP_HOME exactly as withInteractiveTempHome created it:
      // an empty directory, not a half-written home.
      expect(readdirSync(tempHome)).toEqual([]);
    });
  });

  test('--file with --no-start still passes validation (reaches past the new guard)', async () => {
    await withInteractiveTempHome(async (tempHome) => {
      mock.module('@openpalm/lib', () => ({
        ...realLib,
        hasAnyStackEnvFile: () => false,
        hasMaterializedLocalInstall: () => false,
        // Same short-circuit the seed-phase lock test above uses: fail fast at
        // lock acquisition, well before prepareInstallFiles/performSetup, so
        // this stays a unit test of validation order rather than a full
        // (mocked-Docker-free, since --file + --no-start skips it) install.
        acquireInstallLock: () => null,
        releaseInstallLock: () => {},
      }));

      const { bootstrapInstall } = await import(`${installModuleUrl}?t=${Math.random()}`);
      // Rejects for the UNRELATED, controlled reason (lock held) — proving it
      // got past the --no-start/--file guard rather than tripping it.
      await expect(
        bootstrapInstall({
          force: false,
          noStart: true,
          noOpen: true,
          assumeYes: false,
          file: join(tempHome, 'spec.json'),
        }),
      ).rejects.toThrow(/install_in_progress/);
    });
  });
});
