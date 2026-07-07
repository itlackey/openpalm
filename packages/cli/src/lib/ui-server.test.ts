import { describe, expect, it } from 'bun:test';
import { createCliUiSupervisor, type CliChildProc, waitForClientApp } from './ui-server.ts';

// Behavioral coverage for the CLI's thin UiSupervisor adapter, driven through
// injected fakes (no real processes). Locks the exit-based failure policy
// (process.exit(1) on BOTH start- and restart-ready-failure) and the
// SIGTERM → grace-window → conditional-SIGKILL stop sequence.

interface FakeProc extends CliChildProc {
  signals: string[];
}

function fakeProc(opts: { killed: boolean; exits: boolean }): FakeProc {
  const signals: string[] = [];
  return {
    signals,
    kill: ((sig?: number | NodeJS.Signals) => {
      signals.push(String(sig));
    }) as CliChildProc['kill'],
    exited: opts.exits ? Promise.resolve(0) : new Promise<number>(() => {}),
    killed: opts.killed,
  };
}

function harness(opts: {
  readyQueue: boolean[];
  proc?: FakeProc;
  uiBackupDir?: string | undefined;
}) {
  const proc = opts.proc ?? fakeProc({ killed: false, exits: true });
  const exits: number[] = [];
  const restores: Array<string | undefined> = [];
  const errs: unknown[][] = [];
  const readyQueue = [...opts.readyQueue];
  const { supervisor, stop } = createCliUiSupervisor({
    port: 3880,
    spawnChild: async () => ({
      proc: proc as unknown as Bun.Subprocess,
      uiBackupDir: opts.uiBackupDir,
    }),
    waitForReadyFn: async () => readyQueue.shift() ?? false,
    restoreBackup: (b) => restores.push(b),
    exit: (c) => { exits.push(c); },
    logRestartError: (...a) => errs.push(a),
    stopTimeoutMs: 5,
    sleep: () => Promise.resolve(),
    logError: () => {},
  });
  return { supervisor, stop, proc, exits, restores, errs };
}

describe('createCliUiSupervisor stop sequence', () => {
  it('SIGTERMs, then SIGKILLs when the child has not died before the grace window', async () => {
    const proc = fakeProc({ killed: false, exits: false }); // never exits; not killed
    const { stop } = harness({ readyQueue: [true] });
    await stop(proc);
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('SIGTERMs only when the child exits (killed) before the grace window', async () => {
    const proc = fakeProc({ killed: true, exits: true }); // exited + killed → no force-kill
    const { stop } = harness({ readyQueue: [true] });
    await stop(proc);
    expect(proc.signals).toEqual(['SIGTERM']);
  });
});

describe('createCliUiSupervisor exit policy', () => {
  it('start ready-timeout kills the child and exits(1)', async () => {
    const proc = fakeProc({ killed: false, exits: true });
    const { supervisor, exits } = harness({ readyQueue: [false], proc });
    expect(await supervisor.start()).toBe(false);
    expect(proc.signals).toContain('SIGTERM');
    expect(exits).toEqual([1]);
  });

  it('restart ready-failure restores the backup then exits(1)', async () => {
    // start ready, restart NOT ready → restoreBackup(last spawn's backup) → exit(1).
    const { supervisor, exits, restores } = harness({
      readyQueue: [true, false],
      uiBackupDir: '/data/.ui-backup',
    });
    expect(await supervisor.start()).toBe(true);
    expect(await supervisor.restart()).toBe(false);
    expect(restores).toEqual(['/data/.ui-backup']);
    expect(exits).toEqual([1]);
  });

  it('a successful restart neither restores a backup nor exits', async () => {
    const { supervisor, exits, restores } = harness({ readyQueue: [true, true] });
    expect(await supervisor.start()).toBe(true);
    expect(await supervisor.restart()).toBe(true);
    expect(restores).toEqual([]);
    expect(exits).toEqual([]);
  });
});

describe('waitForClientApp', () => {
  it('returns true once the localhost client app becomes reachable', async () => {
    let attempts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('not ready');
      return new Response('<html></html>', { status: 200 });
    }) as typeof fetch;

    try {
      expect(await waitForClientApp('http://127.0.0.1:3890/chat', 1500)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns false when the localhost client app never becomes reachable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('still down');
    }) as typeof fetch;

    try {
      expect(await waitForClientApp('http://127.0.0.1:3890/chat', 250)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
