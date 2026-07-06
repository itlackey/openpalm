// ── P5c RED TESTS (#555) — CLI serves the client on a stable loopback port ────
//
// The supervisor that serves the UI (`openpalm` default serve path AND
// `openpalm admin`) must ALSO start the @openpalm/client static server
// (bin/serve.mjs from the resolved client build) on DEFAULT_CLIENT_PORT=3890,
// loopback-only, supervised/respawned like the UI child, and NON-FATALLY skip
// when no client build is present (plan Phase 5 item 3; phase-5 guide §4 P5c
// item 2).
//
// Pinned contract (these tests are the spec):
//   • `DEFAULT_CLIENT_PORT` lives in src/lib/ports.ts (single source of the
//     magic number, like DEFAULT_UI_PORT) and is 3890 — stable because the
//     localhost PWA identity is origin-including-port (plan §6.10).
//   • New module src/lib/client-server.ts exports:
//       resolveClientServeScript(buildDir) → the serve script that travels with
//         the resolved client build: join(buildDir, '..', 'bin', 'serve.mjs')
//         (holds for BOTH channels: data/client/{build,bin} and
//         $OPENPALM_REPO_ROOT/packages/client/{build,bin}).
//       startClientServer(deps) → Promise<handle | null> with injectable deps
//         (port, resolveBuildDir, existsSync, spawnFn, log/logError, sleep,
//         stopTimeoutMs) so no real process is ever spawned in tests — same
//         style as createCliUiSupervisor in ui-server.test.ts.
//   • The spawned child's env carries the serve.mjs config contract
//     (PORT / HOST / OP_CLIENT_DIR — see packages/client/bin/serve.mjs):
//     HOST is 127.0.0.1 ALWAYS. There is no remote escape hatch:
//     OP_ALLOW_REMOTE_SETUP must NOT loosen the client server's bind (the
//     acceptance line: "loopback-only enforced for the client server").
//   • Absent build → log + skip, return null, spawn nothing, never throw and
//     never exit (the UI must keep serving).
//   • Supervision: an unexpected child exit respawns it; stop() SIGTERMs the
//     child and suppresses any further respawn.
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import * as ports from './ports.ts';
import { startClientServer, resolveClientServeScript } from './client-server.ts';

// ── fakes ─────────────────────────────────────────────────────────────────────

interface FakeClientProc {
  signals: string[];
  kill: (sig?: number | NodeJS.Signals) => void;
  exited: Promise<number>;
  killed: boolean;
  /** Resolve `exited` from the test to simulate the child dying. */
  die: (code: number) => void;
}

function fakeClientProc(): FakeClientProc {
  const signals: string[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => { resolveExit = r; });
  const proc: FakeClientProc = {
    signals,
    exited,
    killed: false,
    die: (code: number) => { resolveExit(code); },
    kill: (sig?: number | NodeJS.Signals) => {
      signals.push(String(sig ?? 'SIGTERM'));
      proc.killed = true;
      resolveExit(0); // a killed fake dies immediately
    },
  };
  return proc;
}

interface SpawnRecord {
  cmd: string[];
  env: Record<string, string | undefined>;
}

function harness(opts: {
  /** One fake proc per spawn; the last repeats for any extra spawns. */
  procs?: FakeClientProc[];
  buildDir?: string;
  /** false = the resolved client build is absent (skip-when-absent path). */
  present?: boolean;
  port?: number;
}) {
  const buildDir = opts.buildDir ?? '/op-home/data/client/build';
  const procs = opts.procs ?? [fakeClientProc()];
  const spawns: SpawnRecord[] = [];
  const logs: string[] = [];
  const handlePromise = startClientServer({
    port: opts.port,
    resolveBuildDir: () => buildDir,
    existsSync: () => opts.present !== false,
    spawnFn: (cmd: string[], o: { env: Record<string, string | undefined> }) => {
      spawns.push({ cmd: [...cmd], env: { ...o.env } });
      return procs[Math.min(spawns.length - 1, procs.length - 1)];
    },
    log: (...a: unknown[]) => { logs.push(a.map(String).join(' ')); },
    logError: (...a: unknown[]) => { logs.push(a.map(String).join(' ')); },
    sleep: () => Promise.resolve(),
    stopTimeoutMs: 5,
  });
  return { handlePromise, spawns, logs, buildDir, procs };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// ── port constant ─────────────────────────────────────────────────────────────

describe('DEFAULT_CLIENT_PORT', () => {
  it('is exported from ports.ts and is 3890 (stable loopback PWA origin, plan §6.10)', () => {
    expect((ports as Record<string, unknown>).DEFAULT_CLIENT_PORT).toBe(3890);
  });
});

// ── serve script resolution ───────────────────────────────────────────────────

describe('resolveClientServeScript', () => {
  it('resolves bin/serve.mjs as a SIBLING of the resolved build dir (both channels)', () => {
    // data channel: OP_HOME/data/client/build → OP_HOME/data/client/bin/serve.mjs
    expect(resolveClientServeScript('/op-home/data/client/build'))
      .toBe(join('/op-home/data/client/bin', 'serve.mjs'));
    // dev channel: repo packages/client/build → packages/client/bin/serve.mjs
    expect(resolveClientServeScript('/repo/packages/client/build'))
      .toBe(join('/repo/packages/client/bin', 'serve.mjs'));
  });
});

// ── spawn env/args ────────────────────────────────────────────────────────────

describe('startClientServer spawn env/args', () => {
  const savedRemote = { value: undefined as string | undefined };

  beforeEach(() => {
    savedRemote.value = process.env.OP_ALLOW_REMOTE_SETUP;
    delete process.env.OP_ALLOW_REMOTE_SETUP;
  });

  afterEach(() => {
    if (savedRemote.value === undefined) delete process.env.OP_ALLOW_REMOTE_SETUP;
    else process.env.OP_ALLOW_REMOTE_SETUP = savedRemote.value;
  });

  it('spawns the serve script with PORT=3890 (default), HOST=127.0.0.1, and OP_CLIENT_DIR=<resolved build>', async () => {
    const { handlePromise, spawns, buildDir } = harness({});
    const handle = await handlePromise;
    expect(handle).not.toBeNull();
    expect(spawns.length).toBe(1);
    const { cmd, env } = spawns[0] as SpawnRecord;
    // serve.mjs reads its config from the environment (PORT/HOST/OP_CLIENT_DIR).
    expect(env.PORT).toBe('3890');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.OP_CLIENT_DIR).toBe(buildDir);
    // The child IS the serve script from the resolved client build.
    expect(cmd).toContain(resolveClientServeScript(buildDir));
    await handle?.stop();
  });

  it('honors a port override', async () => {
    const { handlePromise, spawns } = harness({ port: 4001 });
    const handle = await handlePromise;
    expect((spawns[0] as SpawnRecord).env.PORT).toBe('4001');
    await handle?.stop();
  });

  it('stays loopback-only even when OP_ALLOW_REMOTE_SETUP is set (no remote escape hatch)', async () => {
    // The UI server's remote-setup relaxation must never leak into the client
    // static server: acceptance is "loopback-only enforced for the client
    // server" — HOST stays pinned to 127.0.0.1 unconditionally.
    process.env.OP_ALLOW_REMOTE_SETUP = '1';
    const { handlePromise, spawns } = harness({});
    const handle = await handlePromise;
    expect((spawns[0] as SpawnRecord).env.HOST).toBe('127.0.0.1');
    await handle?.stop();
  });
});

// ── skip-when-absent ──────────────────────────────────────────────────────────

describe('startClientServer skip-when-absent', () => {
  it('returns null, spawns nothing, and logs a skip when the client build is absent', async () => {
    const { handlePromise, spawns, logs } = harness({ present: false });
    // Non-fatal by contract: the promise must RESOLVE (never reject/exit) so
    // the UI supervisor keeps serving without the client.
    const handle = await handlePromise;
    expect(handle).toBeNull();
    expect(spawns.length).toBe(0);
    const logged = logs.join('\n');
    expect(logged).toMatch(/client/i);
    expect(logged).toMatch(/skip/i);
  });
});

// ── supervision ───────────────────────────────────────────────────────────────

describe('startClientServer supervision', () => {
  it('respawns the client child after an unexpected exit', async () => {
    const first = fakeClientProc();
    const second = fakeClientProc();
    const { handlePromise, spawns } = harness({ procs: [first, second] });
    const handle = await handlePromise;
    expect(spawns.length).toBe(1);

    first.die(1); // the child crashes
    await tick();

    expect(spawns.length).toBe(2); // supervised: a fresh child was spawned
    await handle?.stop();
  });

  it('stop() SIGTERMs the child and suppresses any further respawn', async () => {
    const first = fakeClientProc();
    const { handlePromise, spawns, procs } = harness({ procs: [first] });
    const handle = await handlePromise;
    expect(handle).not.toBeNull();

    await handle?.stop();
    await tick();

    expect((procs[0] as FakeClientProc).signals).toContain('SIGTERM');
    expect(spawns.length).toBe(1); // an intentional stop must NOT respawn
  });
});
