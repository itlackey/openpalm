import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const checkDocker = vi.fn();
const checkDockerCompose = vi.fn();
const detectGpu = vi.fn();
const detectLocalProviders = vi.fn();
const detectRuntime = vi.fn();
const execFileMock = vi.fn();

vi.mock('@openpalm/lib', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openpalm/lib')>();
  return {
    ...original,
    checkDocker,
    checkDockerCompose,
    detectGpu,
    detectLocalProviders,
    detectRuntime,
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
    emitter.listen = (port: number, _host: string) => {
      setTimeout(() => {
        if (port === 3880 || port === 3800) {
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
    process.env.OP_HOST_ASSISTANT_PORT = '3800';
  });

  afterEach(() => {
    delete process.env.PORT;
    delete process.env.OP_HOST_UI_PORT;
    delete process.env.OP_HOST_ASSISTANT_PORT;
  });

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
      cb(null, 'openpalm-assistant-1\t0.0.0.0:3800->4096/tcp\n', '');
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
      service: 'assistant',
      available: true,
      blocking: true,
    });
  });
});
