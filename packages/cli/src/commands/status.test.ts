/**
 * CLI status command — snapshot tests for deriveLaunchStatus output shape.
 *
 * These are pure unit tests: they mock the I/O helpers used by status.ts
 * and assert that the JSON printed to stdout has the expected structure for
 * the common `running` and `not_installed` scenarios.
 */
import { describe, expect, test, mock, afterEach } from 'bun:test';
import * as realLib from '@openpalm/lib';

const libUrl = '@openpalm/lib';

// `import * as realLib` is the LIVE module record that mock.module() rewrites in
// place — every specifier for this package (bare or relative) resolves to the
// same namespace object. Spreading it inside afterEach would therefore capture
// whichever mock was last installed and "restore" that, permanently baking a
// stub like `classifyLocalInstall: () => 'installed'` into the shared process.
// Snapshot the real exports ONCE, at load, before any mock.module() call.
const REAL_LIB = { ...realLib };

afterEach(() => {
  mock.restore();
  // mock.restore() does NOT undo mock.module(), so the @openpalm/lib mock below
  // would otherwise leak into every other test file in the shared `bun test`
  // process (other CLI tests get a partial lib → undefined fns → flaky rejection).
  // Re-point it back to the real package.
  mock.module(libUrl, () => REAL_LIB);
});

// Helper that captures what was logged to stdout/stderr during the command run.
async function runStatusCommand(): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  };
  try {
    const mod = await import(`./status.ts?t=${Math.random()}`);
    await mod.default.run?.({} as never);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('openpalm status — deriveLaunchStatus snapshot', () => {
  test('prints a valid LaunchStatus JSON when the stack is running', async () => {
    mock.module(libUrl, () => ({
      ...realLib,
      classifyLocalInstall: () => 'installed',
      composePs: async () => ({
        ok: true,
        stdout: JSON.stringify({ Service: 'assistant', State: 'running', Health: 'healthy' }),
        stderr: '',
        exitCode: 0,
      }),
      buildComposeOptions: () => ({}),
      deriveLocalStackState: () => 'running',
      deriveLaunchStatus: (input: { local: { state: string }; remotes: unknown[] }) => ({
        local: input.local,
        remotes: [],
        hasHealthyLocal: true,
        localInstalledButUnhealthy: false,
        hasAccessibleRemote: false,
        recommendedRoute: 'chat',
        activeAssistant: { kind: 'local' },
        alerts: [],
      }),
      detectRuntime: async () => ({ dockerPresent: true, composeAvailable: true }),
    }));

    const { stdout } = await runStatusCommand();

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.recommendedRoute).toBe('chat');
    expect(parsed.hasHealthyLocal).toBe(true);
    expect(parsed.localInstalledButUnhealthy).toBe(false);
    expect(parsed.hasAccessibleRemote).toBe(false);
    expect(parsed.activeAssistant).toEqual({ kind: 'local' });
    expect(Array.isArray(parsed.alerts)).toBe(true);
    expect(Array.isArray(parsed.remotes)).toBe(true);
  });

  test('prints splash route when stack is not installed', async () => {
    mock.module(libUrl, () => ({
      ...realLib,
      classifyLocalInstall: () => 'not_installed',
      composePs: async () => ({ ok: false, stdout: '', stderr: '', exitCode: 1 }),
      buildComposeOptions: () => ({}),
      deriveLocalStackState: () => 'not_installed',
      deriveLaunchStatus: (input: { local: { state: string }; remotes: unknown[] }) => ({
        local: input.local,
        remotes: [],
        hasHealthyLocal: false,
        localInstalledButUnhealthy: false,
        hasAccessibleRemote: false,
        recommendedRoute: 'splash',
        activeAssistant: null,
        alerts: [],
      }),
      detectRuntime: async () => ({
        dockerPresent: true,
        composeAvailable: true,
        runtimeName: 'Docker',
      }),
    }));

    const { stdout } = await runStatusCommand();

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.recommendedRoute).toBe('splash');
    expect(parsed.hasHealthyLocal).toBe(false);
    expect(parsed.activeAssistant).toBeNull();
  });

  test('prints splash with localInstalledButUnhealthy when stack is offline', async () => {
    mock.module(libUrl, () => ({
      ...realLib,
      classifyLocalInstall: () => 'installed',
      composePs: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0 }),
      buildComposeOptions: () => ({}),
      deriveLocalStackState: () => 'installed_offline',
      deriveLaunchStatus: (input: { local: { state: string }; remotes: unknown[] }) => ({
        local: input.local,
        remotes: [],
        hasHealthyLocal: false,
        localInstalledButUnhealthy: true,
        hasAccessibleRemote: false,
        recommendedRoute: 'splash',
        activeAssistant: null,
        alerts: [],
      }),
      detectRuntime: async () => ({ dockerPresent: true, composeAvailable: true }),
    }));

    const { stdout } = await runStatusCommand();

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.recommendedRoute).toBe('splash');
    expect(parsed.localInstalledButUnhealthy).toBe(true);
    expect(parsed.activeAssistant).toBeNull();
  });
});
