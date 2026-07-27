import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:net';
import {
  checkPortAvailable,
  portHeldByOurContainer,
  probeInstallPorts,
  resolveInstallPortTargets,
  type InstallPortTarget,
} from './port-probe.js';
import type { DockerClient, DockerResult } from './docker.js';

function fakeClient(run: (args: string[]) => Promise<DockerResult>): DockerClient {
  return { run: (args) => run(args) };
}

const okResult = (stdout: string): DockerResult => ({ ok: true, stdout, stderr: '', code: 0 });
const failResult: DockerResult = { ok: false, stdout: '', stderr: 'ENOENT', code: 1 };

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('checkPortAvailable', () => {
  it('reports true for a free ephemeral port', async () => {
    // Bind to port 0 to get a genuinely free port from the OS, close it, then
    // probe THAT port — avoids hardcoding a port that might be taken on CI.
    const probe = createServer();
    const port: number = await new Promise((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    expect(await checkPortAvailable(port)).toBe(true);
  });

  it('reports false for a port currently bound by this process', async () => {
    server = createServer();
    const port: number = await new Promise((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const addr = server?.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    expect(await checkPortAvailable(port)).toBe(false);
  });
});

describe('portHeldByOurContainer', () => {
  it('returns "held" when an openpalm-* container publishes the port', async () => {
    const client = fakeClient(async () => okResult('openpalm-assistant\t0.0.0.0:3810->3810/tcp\n'));
    expect(await portHeldByOurContainer(3810, client)).toBe('held');
  });

  it('returns "free" when no openpalm-* container publishes the port', async () => {
    const client = fakeClient(async () => okResult('some-other-container\t0.0.0.0:9999->9999/tcp\n'));
    expect(await portHeldByOurContainer(3810, client)).toBe('free');
  });

  it('ignores non-openpalm containers even if they happen to publish the port', async () => {
    const client = fakeClient(async () => okResult('random-app\t0.0.0.0:3810->3810/tcp\n'));
    expect(await portHeldByOurContainer(3810, client)).toBe('free');
  });

  it('returns "unreachable" when docker itself cannot be queried', async () => {
    const client = fakeClient(async () => failResult);
    expect(await portHeldByOurContainer(3810, client)).toBe('unreachable');
  });
});

describe('resolveInstallPortTargets', () => {
  it('defaults to 3880/3800/3810 when no env overrides are set', () => {
    const originals = ['OP_HOST_UI_PORT', 'OP_UI_PORT', 'OP_ASSISTANT_PORT'].map((k) => [k, process.env[k]] as const);
    for (const [k] of originals) delete process.env[k];
    try {
      const targets = resolveInstallPortTargets();
      expect(targets.map((t) => t.port)).toEqual([3880, 3800, 3810]);
      expect(targets.every((t) => t.blocking)).toBe(true);
    } finally {
      for (const [k, v] of originals) if (v !== undefined) process.env[k] = v;
    }
  });

  it('honors OP_HOST_UI_PORT/OP_UI_PORT/OP_ASSISTANT_PORT overrides', () => {
    const originals = ['OP_HOST_UI_PORT', 'OP_UI_PORT', 'OP_ASSISTANT_PORT'].map((k) => [k, process.env[k]] as const);
    try {
      process.env.OP_HOST_UI_PORT = '4880';
      process.env.OP_UI_PORT = '4800';
      process.env.OP_ASSISTANT_PORT = '4810';
      expect(resolveInstallPortTargets().map((t) => t.port)).toEqual([4880, 4800, 4810]);
    } finally {
      for (const [k, v] of originals) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('probeInstallPorts (C2 — no false conflict while our own stack is up)', () => {
  const targets: InstallPortTarget[] = [{ port: 65000, service: 'admin', blocking: true }];

  it('marks a port held by our own container as available, not a conflict', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(65000, '127.0.0.1', () => resolve()));

    const client = fakeClient(async () => okResult('openpalm-admin\t0.0.0.0:65000->65000/tcp\n'));
    const results = await probeInstallPorts(targets, { client, dockerAvailable: true });

    expect(results[0]?.available).toBe(true);
    expect(results[0]?.ownership).toBe('held');
  });

  it('flags a genuinely foreign process on the port as a blocking conflict', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(65000, '127.0.0.1', () => resolve()));

    const client = fakeClient(async () => okResult('some-other-app\t0.0.0.0:65000->65000/tcp\n'));
    const results = await probeInstallPorts(targets, { client, dockerAvailable: true });

    expect(results[0]?.available).toBe(false);
    expect(results[0]?.blocking).toBe(true);
  });

  it('downgrades a conflict to non-blocking when Docker is unreachable (can\'t verify ownership)', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(65000, '127.0.0.1', () => resolve()));

    const client = fakeClient(async () => okResult('irrelevant'));
    const results = await probeInstallPorts(targets, { client, dockerAvailable: false });

    expect(results[0]?.available).toBe(false);
    expect(results[0]?.blocking).toBe(false);
  });

  it('treats the caller\'s own server port as available without any docker call', async () => {
    let called = false;
    const client = fakeClient(async () => {
      called = true;
      return okResult('');
    });
    const results = await probeInstallPorts(targets, { client, serverPort: 65000 });

    expect(results[0]?.available).toBe(true);
    expect(results[0]?.ownership).toBe('ours');
    expect(called).toBe(false);
  });
});
