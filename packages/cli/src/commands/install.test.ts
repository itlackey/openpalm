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
import { expect, test } from 'bun:test';
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
