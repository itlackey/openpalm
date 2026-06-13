import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();

vi.mock('$lib/server/endpoints.js', () => ({
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

type FakeProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
};

function createProc(pid: number): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = pid;
  proc.exitCode = null;
  proc.kill = vi.fn(() => {
    proc.exitCode = 0;
    proc.emit('exit', 0);
    return true;
  });
  return proc;
}

describe('POST /api/setup/opencode/ensure', () => {
  const originalUrl = process.env.OP_OPENCODE_URL;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.OP_OPENCODE_URL = 'http://127.0.0.1:3800';
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.OP_OPENCODE_URL;
    else process.env.OP_OPENCODE_URL = originalUrl;
    vi.unstubAllGlobals();
  });

  test('double POST shares one spawned process', async () => {
    const proc = createProc(1001);
    spawnMock.mockReturnValue(proc);

    const fetchMock = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./+server.js');
    const first = mod.POST({} as Parameters<typeof mod.POST>[0]);
    const second = mod.POST({} as Parameters<typeof mod.POST>[0]);

    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('server listening on http://127.0.0.1:40123\n'));
    }, 0);

    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const firstBody = await firstRes.json() as { ok: boolean; url: string; started: boolean };
    const secondBody = await secondRes.json() as { ok: boolean; url: string; started: boolean };
    expect(firstBody).toEqual({ ok: true, url: 'http://127.0.0.1:40123', started: true });
    expect(secondBody).toEqual({ ok: true, url: 'http://127.0.0.1:40123', started: true });
    expect(process.env.OP_OPENCODE_URL).toBe('http://127.0.0.1:3800');
  });

  test('exit after resolve clears wizard state and a later call respawns', async () => {
    const firstProc = createProc(1002);
    const secondProc = createProc(1003);
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const fetchMock = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./+server.js');
    const firstCall = mod.POST({} as Parameters<typeof mod.POST>[0]);
    setTimeout(() => {
      firstProc.stdout.emit('data', Buffer.from('server listening on http://127.0.0.1:40124\n'));
    }, 0);
    await firstCall;

    firstProc.exitCode = 1;
    firstProc.emit('exit', 1);

    const secondCall = mod.POST({} as Parameters<typeof mod.POST>[0]);
    setTimeout(() => {
      secondProc.stdout.emit('data', Buffer.from('server listening on http://127.0.0.1:40125\n'));
    }, 0);
    const secondRes = await secondCall;
    const secondBody = await secondRes.json() as { ok: boolean; url: string; started: boolean };

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(secondBody).toEqual({ ok: true, url: 'http://127.0.0.1:40125', started: true });
    expect(process.env.OP_OPENCODE_URL).toBe('http://127.0.0.1:3800');
  });
});
