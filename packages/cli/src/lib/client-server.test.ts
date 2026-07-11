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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ports from './ports.ts';
import {
  startClientServer, resolveClientServeScript, resolveDefaultAssistantUrl,
  resolveClientServePort, resolveClientServeUrl,
  resolveHostUiPort, resolveHostUiUrl,
} from './client-server.ts';

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
  /** Records every ms a respawn/stop `sleep` call was made with (D1 backoff test). */
  sleepDelays?: number[];
  /** Fake clock for the respawn-counter reset test (advisory fix). */
  now?: () => number;
}) {
  const buildDir = opts.buildDir ?? '/op-home/data/client/build';
  const procs = opts.procs ?? [fakeClientProc()];
  const spawns: SpawnRecord[] = [];
  const logs: string[] = [];
  const runtimeConfigWrites: Array<{ path: string; assistantUrl: string; hostUrl?: string }> = [];
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
    resolveRuntimeConfigPath: () => '/op-home/data/client/runtime-config.json',
    resolveAssistantUrl: () => process.env.OP_CLIENT_DEFAULT_ASSISTANT_URL || `http://127.0.0.1:${process.env.OP_ASSISTANT_PORT || '3800'}`,
    writeRuntimeConfig: (path: string, assistantUrl: string, options?: { hostUrl?: string }) => {
      runtimeConfigWrites.push({ path, assistantUrl, ...(options?.hostUrl ? { hostUrl: options.hostUrl } : {}) });
    },
    sleep: (ms: number) => { opts.sleepDelays?.push(ms); return Promise.resolve(); },
    stopTimeoutMs: 5,
    now: opts.now,
  });
  return { handlePromise, spawns, logs, buildDir, procs, runtimeConfigWrites };
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

// E1: resolveDefaultAssistantUrl now delegates to @openpalm/lib's
// resolveAssistantEndpoint(homeDir, env), so it picks up the SAME
// OP_OPENCODE_URL / OP_ASSISTANT_URL overrides the host UI honors — before
// this fix the CLI only ever looked at OP_CLIENT_DEFAULT_ASSISTANT_URL and
// silently ignored the other two, producing "chat works in the host UI but
// not the CLI-served client app" for operators who set them.
describe('resolveDefaultAssistantUrl (E1: shared @openpalm/lib resolver)', () => {
  let tmpHome: string;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['OP_HOME', 'OP_CLIENT_DEFAULT_ASSISTANT_URL', 'OP_OPENCODE_URL', 'OP_ASSISTANT_URL', 'OP_ASSISTANT_PORT'];

  beforeEach(() => {
    for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
    tmpHome = mkdtempSync(join(tmpdir(), 'openpalm-e1-'));
    process.env.OP_HOME = tmpHome;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('falls back to the loopback assistant port when nothing overrides it', () => {
    expect(resolveDefaultAssistantUrl()).toBe('http://127.0.0.1:3800');
    process.env.OP_ASSISTANT_PORT = '4800';
    expect(resolveDefaultAssistantUrl()).toBe('http://127.0.0.1:4800');
  });

  it('honors OP_CLIENT_DEFAULT_ASSISTANT_URL', () => {
    process.env.OP_CLIENT_DEFAULT_ASSISTANT_URL = 'https://assistant.example';
    expect(resolveDefaultAssistantUrl()).toBe('https://assistant.example');
  });

  it('honors OP_OPENCODE_URL (previously ignored by the CLI)', () => {
    process.env.OP_OPENCODE_URL = 'https://oc.example.internal';
    expect(resolveDefaultAssistantUrl()).toBe('https://oc.example.internal');
  });

  it('honors OP_ASSISTANT_URL (previously ignored by the CLI)', () => {
    process.env.OP_ASSISTANT_URL = 'https://assistant2.example.internal';
    expect(resolveDefaultAssistantUrl()).toBe('https://assistant2.example.internal');
  });
});

// ── D2: one authoritative client port/URL resolver ────────────────────────────

describe('resolveClientServePort / resolveClientServeUrl (D2)', () => {
  it('uses OP_HOST_CLIENT_PORT from persisted stack.env when process.env has none — the SAME merge startClientServer spawns on', () => {
    expect(resolveClientServePort({}, { OP_HOST_CLIENT_PORT: '9392' })).toBe(9392);
    expect(resolveClientServeUrl({}, { OP_HOST_CLIENT_PORT: '9392' })).toBe('http://127.0.0.1:9392/chat');
  });

  it('lets process.env override the persisted value', () => {
    expect(resolveClientServePort(
      { OP_HOST_CLIENT_PORT: '9400' } as NodeJS.ProcessEnv,
      { OP_HOST_CLIENT_PORT: '9392' },
    )).toBe(9400);
  });

  it('falls back to DEFAULT_CLIENT_PORT (3890) when nothing is set', () => {
    expect(resolveClientServePort({}, {})).toBe(3890);
  });
});

// ── spawn env/args ────────────────────────────────────────────────────────────

describe('startClientServer spawn env/args', () => {
  const savedRemote = { value: undefined as string | undefined };
  const savedClientPort = { value: undefined as string | undefined };
  const savedHostClientPort = { value: undefined as string | undefined };
  const savedAssistantPort = { value: undefined as string | undefined };
  const savedDefaultAssistantUrl = { value: undefined as string | undefined };
  const savedHostUiPort = { value: undefined as string | undefined };

  beforeEach(() => {
    savedRemote.value = process.env.OP_ALLOW_REMOTE_SETUP;
    savedClientPort.value = process.env.OP_CLIENT_PORT;
    savedHostClientPort.value = process.env.OP_HOST_CLIENT_PORT;
    savedAssistantPort.value = process.env.OP_ASSISTANT_PORT;
    savedDefaultAssistantUrl.value = process.env.OP_CLIENT_DEFAULT_ASSISTANT_URL;
    savedHostUiPort.value = process.env.OP_HOST_UI_PORT;
    delete process.env.OP_ALLOW_REMOTE_SETUP;
    delete process.env.OP_CLIENT_PORT;
    delete process.env.OP_HOST_CLIENT_PORT;
    delete process.env.OP_ASSISTANT_PORT;
    delete process.env.OP_CLIENT_DEFAULT_ASSISTANT_URL;
    delete process.env.OP_HOST_UI_PORT;
  });

  afterEach(() => {
    if (savedRemote.value === undefined) delete process.env.OP_ALLOW_REMOTE_SETUP;
    else process.env.OP_ALLOW_REMOTE_SETUP = savedRemote.value;
    if (savedClientPort.value === undefined) delete process.env.OP_CLIENT_PORT;
    else process.env.OP_CLIENT_PORT = savedClientPort.value;
    if (savedHostClientPort.value === undefined) delete process.env.OP_HOST_CLIENT_PORT;
    else process.env.OP_HOST_CLIENT_PORT = savedHostClientPort.value;
    if (savedAssistantPort.value === undefined) delete process.env.OP_ASSISTANT_PORT;
    else process.env.OP_ASSISTANT_PORT = savedAssistantPort.value;
    if (savedDefaultAssistantUrl.value === undefined) delete process.env.OP_CLIENT_DEFAULT_ASSISTANT_URL;
    else process.env.OP_CLIENT_DEFAULT_ASSISTANT_URL = savedDefaultAssistantUrl.value;
    if (savedHostUiPort.value === undefined) delete process.env.OP_HOST_UI_PORT;
    else process.env.OP_HOST_UI_PORT = savedHostUiPort.value;
  });

  it('spawns the serve script with PORT=3890 (default), HOST=127.0.0.1, and OP_CLIENT_DIR=<resolved build>', async () => {
    const { handlePromise, spawns, buildDir, runtimeConfigWrites } = harness({});
    const handle = await handlePromise;
    expect(handle).not.toBeNull();
    expect(spawns.length).toBe(1);
    const { cmd, env } = spawns[0] as SpawnRecord;
    // serve.mjs reads its config from the environment (PORT/HOST/OP_CLIENT_DIR).
    expect(env.PORT).toBe('3890');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.OP_CLIENT_DIR).toBe(buildDir);
    expect(env.OP_CLIENT_RUNTIME_CONFIG).toBe('/op-home/data/client/runtime-config.json');
    expect(runtimeConfigWrites).toEqual([
      {
        path: '/op-home/data/client/runtime-config.json',
        assistantUrl: 'http://127.0.0.1:3800',
        hostUrl: 'http://127.0.0.1:3880/host',
      },
    ]);
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

  it('seeds runtime-config.json with the assistant URL override when configured', async () => {
    process.env.OP_CLIENT_DEFAULT_ASSISTANT_URL = 'https://assistant.example/oc';
    const { handlePromise, runtimeConfigWrites } = harness({});
    const handle = await handlePromise;
    expect(runtimeConfigWrites).toEqual([
      {
        path: '/op-home/data/client/runtime-config.json',
        assistantUrl: 'https://assistant.example/oc',
        hostUrl: 'http://127.0.0.1:3880/host',
      },
    ]);
    await handle?.stop();
  });

  it('uses OP_HOST_CLIENT_PORT when no explicit port is passed', async () => {
    process.env.OP_HOST_CLIENT_PORT = '4011';
    const { handlePromise, spawns } = harness({});
    const handle = await handlePromise;
    expect((spawns[0] as SpawnRecord).env.PORT).toBe('4011');
    await handle?.stop();
  });

  it('does not let OP_CLIENT_PORT override the stable host localhost app port', async () => {
    process.env.OP_CLIENT_PORT = '4810';
    const { handlePromise, spawns } = harness({});
    const handle = await handlePromise;
    expect((spawns[0] as SpawnRecord).env.PORT).toBe('3890');
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

  // Review advisory (LOW, consistency): the CLI-served client never received
  // hostUrl, so it silently lacked the "Manage assistant" affordance the
  // Electron-served client gets (main.ts's buildClientRuntimeConfigOptions).
  // The CLI IS a host process serving the host UI at OP_HOST_UI_PORT (default
  // DEFAULT_UI_PORT/3880) on this same machine, so it can point the client at
  // the same /host admin surface.
  it('seeds runtime-config.json hostUrl with the host UI\'s /host URL (default port)', async () => {
    const { handlePromise, runtimeConfigWrites } = harness({});
    const handle = await handlePromise;
    expect(runtimeConfigWrites.at(-1)?.hostUrl).toBe('http://127.0.0.1:3880/host');
    await handle?.stop();
  });

  it('honors OP_HOST_UI_PORT for the seeded hostUrl', async () => {
    process.env.OP_HOST_UI_PORT = '4880';
    const { handlePromise, runtimeConfigWrites } = harness({});
    const handle = await handlePromise;
    expect(runtimeConfigWrites.at(-1)?.hostUrl).toBe('http://127.0.0.1:4880/host');
    await handle?.stop();
  });
});

// ── resolveHostUiPort / resolveHostUiUrl (A2/H4 CLI parity) ───────────────────

describe('resolveHostUiPort / resolveHostUiUrl', () => {
  it('uses OP_HOST_UI_PORT from persisted stack.env when process.env has none', () => {
    expect(resolveHostUiPort({}, { OP_HOST_UI_PORT: '9200' })).toBe(9200);
    expect(resolveHostUiUrl({}, { OP_HOST_UI_PORT: '9200' })).toBe('http://127.0.0.1:9200');
  });

  it('lets process.env override the persisted value', () => {
    expect(resolveHostUiPort(
      { OP_HOST_UI_PORT: '9300' } as NodeJS.ProcessEnv,
      { OP_HOST_UI_PORT: '9200' },
    )).toBe(9300);
  });

  it('falls back to DEFAULT_UI_PORT (3880) when nothing is set', () => {
    expect(resolveHostUiPort({}, {})).toBe(3880);
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

  // D1: an immediately-crashing child (e.g. EADDRINUSE) must not respawn at a
  // flat 1/s forever — cap the attempts and back off exponentially between them.
  it('caps the respawn loop and backs off exponentially instead of respawning forever', async () => {
    const procs = Array.from({ length: 6 }, () => fakeClientProc());
    const sleepDelays: number[] = [];
    const { handlePromise, spawns, logs } = harness({ procs, sleepDelays });
    const handle = await handlePromise;
    expect(spawns.length).toBe(1);

    for (const proc of procs) {
      proc.die(1);
      await tick();
    }

    // 1 initial spawn + 5 respawns (MAX_RESPAWN_ATTEMPTS) = 6 total; the 6th
    // exit does NOT trigger a 7th respawn — the loop gave up.
    expect(spawns.length).toBe(6);
    expect(sleepDelays).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(logs.join('\n')).toMatch(/giving up/i);

    await handle?.stop();
  });

  // Advisory (review): respawnAttempt used to never reset once incremented, so
  // a child that crashed MAX_RESPAWN_ATTEMPTS times cumulatively over the
  // ENTIRE process lifetime — even hours apart, with long healthy stretches
  // in between — permanently gave up. A sustained healthy run should reset
  // the counter so only a PERSISTENTLY-broken child exhausts the cap.
  it('resets the respawn-attempt counter after a sustained healthy run instead of accumulating forever', async () => {
    const procs = Array.from({ length: 4 }, () => fakeClientProc());
    const sleepDelays: number[] = [];
    let clock = 0;
    const { handlePromise, spawns, logs } = harness({ procs, sleepDelays, now: () => clock });
    const handle = await handlePromise;
    expect(spawns.length).toBe(1); // initial spawn, spawnedAt = clock (0)

    // Two quick crashes (uptime 0 both times): attempts 1 and 2, exponential backoff.
    procs[0].die(1);
    await tick();
    procs[1].die(1);
    await tick();
    expect(spawns.length).toBe(3);
    expect(sleepDelays).toEqual([1000, 2000]);

    // The third child runs healthy for a full minute before crashing — long
    // enough to reset the give-up counter.
    clock += 60_000;
    procs[2].die(1);
    await tick();
    // Reset happened: back to the BASE delay (1000ms), not the next
    // exponential step (4000ms) an un-reset counter would have used.
    expect(sleepDelays).toEqual([1000, 2000, 1000]);
    expect(spawns.length).toBe(4);
    expect(logs.join('\n')).not.toMatch(/giving up/i);

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
