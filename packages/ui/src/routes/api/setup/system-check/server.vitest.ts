import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const checkDocker = vi.fn();
const checkDockerCompose = vi.fn();
const detectGpu = vi.fn();
const detectLocalProviders = vi.fn();
const detectRuntime = vi.fn();
const execFileMock = vi.fn();
// W11: real checkLifecycleDiskHeadroom shells out to `docker info` and statfs
// — mocked so this suite stays hermetic and fast, and so each test can set an
// exact disk reading without depending on the sandbox's actual free space.
const checkLifecycleDiskHeadroom = vi.fn();

vi.mock('@openpalm/lib', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openpalm/lib')>();
  return {
    ...original,
    checkDocker,
    checkDockerCompose,
    detectGpu,
    detectLocalProviders,
    detectRuntime,
    checkLifecycleDiskHeadroom,
    resolveOpenPalmHome: () => '/fake/home',
  };
});

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('node:net', () => ({
  createServer: () => {
    const emitter = new EventEmitter() as EventEmitter & {
      close: () => void;
      listen: (port: number, host: string) => void;
    };
    emitter.close = () => {};
    emitter.listen = (port: number) => {
      setTimeout(() => {
        if (port === 3880 || port === 3800 || port === 3810) {
          emitter.emit('error', new Error('in use'));
        } else {
          emitter.emit('listening');
        }
      }, 0);
    };
    return emitter;
  },
}));

describe('GET /api/setup/system-check', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    checkDocker.mockResolvedValue({ ok: true, stdout: '27.0.1', stderr: '', code: 0 });
    checkDockerCompose.mockResolvedValue({ ok: true, stdout: 'Docker Compose version v2.29.1', stderr: '', code: 0 });
    detectGpu.mockResolvedValue(null);
    detectLocalProviders.mockResolvedValue([]);
    detectRuntime.mockResolvedValue({
      dockerPresent: true,
      dockerVersion: '27.0.1',
      composeAvailable: true,
      runtimeName: 'OrbStack',
    });
    process.env.PORT = '5173';
    process.env.OP_HOST_UI_PORT = '3880';
    process.env.OP_UI_PORT = '3800';
    process.env.OP_ASSISTANT_PORT = '3810';
    checkLifecycleDiskHeadroom.mockResolvedValue(diskHeadroom('ok'));
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_HOST_UI_PORT;
    delete process.env.OP_UI_PORT;
    delete process.env.OP_ASSISTANT_PORT;
    delete process.env.OP_DISK_HARD_BLOCK;
  });

  const GIB = 1024 ** 3;

  function diskHeadroom(status: 'ok' | 'low' | 'critical') {
    const freeBytes = status === 'critical' ? 0.5 * GIB : status === 'low' ? 3 * GIB : 50 * GIB;
    const reading = {
      path: '/fake/home', status, freeBytes, totalBytes: 500 * GIB, measurementFailed: false,
      lowThresholdBytes: 5 * GIB, criticalThresholdBytes: 1 * GIB,
    };
    return { home: reading, dockerRoot: null, dockerRootSkipped: 'unresolved' as const, worst: reading };
  }

  test('degrades port conflicts to non-blocking when docker ps is unreachable', async () => {
    execFileMock.mockImplementation((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (error: Error | null, stdout: string, stderr: string) => void,
    ) => cb(new Error('docker down'), '', 'cannot connect'));

    const mod = await import('./+server.js');
    const res = await mod.GET({} as Parameters<typeof mod.GET>[0]);
    const body = await res.json() as {
      portCheckReliable: boolean;
      ports: Array<{ port: number; available: boolean; blocking: boolean }>;
      runtime: { runtimeName?: string };
    };

    expect(body.portCheckReliable).toBe(false);
    expect(body.ports.find((port) => port.port === 3800)).toEqual({
      port: 3800,
      service: 'ui',
      available: false,
      blocking: false,
    });
    expect(body.ports.find((port) => port.port === 3810)).toEqual({
      port: 3810,
      service: 'assistant',
      available: false,
      blocking: false,
    });
    expect(body.runtime.runtimeName).toBe('OrbStack');
  }, 20_000);

  test('treats ports held by openpalm containers as available', async () => {
    execFileMock.mockImplementation((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, 'openpalm-assistant-1\t127.0.0.1:3800->3000/tcp, 0.0.0.0:3810->4096/tcp\n', '');
    });

    const mod = await import('./+server.js');
    const res = await mod.GET({} as Parameters<typeof mod.GET>[0]);
    const body = await res.json() as {
      portCheckReliable: boolean;
      ports: Array<{ port: number; available: boolean; blocking: boolean }>;
    };

    expect(body.portCheckReliable).toBe(true);
    expect(body.ports.find((port) => port.port === 3800)).toEqual({
      port: 3800,
      service: 'ui',
      available: true,
      blocking: true,
    });
    expect(body.ports.find((port) => port.port === 3810)).toEqual({
      port: 3810,
      service: 'assistant',
      available: true,
      blocking: true,
    });
  });

  // W11: disk headroom used to reach only a server-side log during apply —
  // never the browser. These pin the route's contract for surfacing it.
  describe('disk headroom (W11)', () => {
    test('an "ok" reading is not surfaced as a warning', async () => {
      const mod = await import('./+server.js');
      const res = await mod.GET({} as Parameters<typeof mod.GET>[0]);
      const body = await res.json() as { disk: { status: string; blocking: boolean; message: string | null } };

      expect(body.disk).toEqual({ status: 'ok', message: null, blocking: false });
    });

    test('a critical reading warns but does not block by default', async () => {
      checkLifecycleDiskHeadroom.mockResolvedValue(diskHeadroom('critical'));

      const mod = await import('./+server.js');
      const res = await mod.GET({} as Parameters<typeof mod.GET>[0]);
      const body = await res.json() as { disk: { status: string; blocking: boolean; message: string | null } };

      expect(body.disk.status).toBe('critical');
      expect(body.disk.blocking).toBe(false);
      expect(body.disk.message).toMatch(/critically low disk space/i);
    });

    test('a critical reading blocks only when OP_DISK_HARD_BLOCK=1 is set', async () => {
      process.env.OP_DISK_HARD_BLOCK = '1';
      checkLifecycleDiskHeadroom.mockResolvedValue(diskHeadroom('critical'));

      const mod = await import('./+server.js');
      const res = await mod.GET({} as Parameters<typeof mod.GET>[0]);
      const body = await res.json() as { disk: { status: string; blocking: boolean } };

      expect(body.disk.blocking).toBe(true);
    });

    test('a "low" reading never blocks, even with the hard-block flag set', async () => {
      process.env.OP_DISK_HARD_BLOCK = '1';
      checkLifecycleDiskHeadroom.mockResolvedValue(diskHeadroom('low'));

      const mod = await import('./+server.js');
      const res = await mod.GET({} as Parameters<typeof mod.GET>[0]);
      const body = await res.json() as { disk: { status: string; blocking: boolean } };

      expect(body.disk.status).toBe('low');
      expect(body.disk.blocking).toBe(false);
    });
  });
});
