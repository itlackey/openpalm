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
  const composeProject = { name: 'my-project', workingDir: '/tmp/op-home/system/stack' };

  it('returns "unreachable" when docker itself cannot be queried', async () => {
    const client = fakeClient(async () => failResult);
    expect(await portHeldByOurContainer(3810, composeProject, client)).toBe('unreachable');
  });

  it('queries the matching project and requires its working-directory label', async () => {
    let args: string[] = [];
    const client = fakeClient(async (seenArgs) => {
      args = seenArgs;
      return okResult('/tmp/op-home/system/stack\t127.0.0.1:3810->4096/tcp\n');
    });

    expect(await portHeldByOurContainer(3810, composeProject, client)).toBe('held');
    expect(args).toContain('label=com.docker.compose.project=my-project');
  });

  const renderings = [
    ['exact IPv4 loopback TCP publication', '127.0.0.1:3810->4096/tcp', 'held'],
    ['another IPv4 loopback address', '127.0.0.2:3810->4096/tcp', 'held'],
    ['host-port range containing the port', '127.0.0.1:3808-3811->4094-4097/tcp', 'held'],
    ['host-port range excluding the port', '127.0.0.1:3808-3809->4094-4095/tcp', 'free'],
    ['UDP publication', '127.0.0.1:3810->4096/udp', 'free'],
    ['wildcard IPv4 publication', '0.0.0.0:3810->4096/tcp', 'held'],
    ['LAN-address publication', '192.168.1.20:3810->4096/tcp', 'free'],
    ['IPv6 loopback publication', '[::1]:3810->4096/tcp', 'free'],
    ['unpublished container port', '4096/tcp', 'free'],
    ['different exact host port', '127.0.0.1:13810->4096/tcp', 'free'],
  ] as const;

  for (const [name, ports, expected] of renderings) {
    it(`classifies ${name}`, async () => {
      const client = fakeClient(async () => okResult(`${composeProject.workingDir}\t${ports}\n`));
      expect(await portHeldByOurContainer(3810, composeProject, client)).toBe(expected);
    });
  }

  it('accepts a matching publication among multiple rendered mappings', async () => {
    const client = fakeClient(async () =>
      okResult(`${composeProject.workingDir}\t0.0.0.0:9000->9000/tcp, 127.0.0.1:3810->4096/tcp\n`),
    );
    expect(await portHeldByOurContainer(3810, composeProject, client)).toBe('held');
  });

  it('does not attribute a foreign listener merely because this project exists', async () => {
    const client = fakeClient(async () =>
      okResult(
        [
          '/tmp/op-home/system/stack\t127.0.0.1:3900->3000/tcp',
          '/tmp/other-home/system/stack\t127.0.0.1:3810->4096/tcp',
        ].join('\n'),
      ),
    );

    expect(
      await portHeldByOurContainer(3810, composeProject, client),
    ).toBe('free');
  });
});

describe('resolveInstallPortTargets', () => {
  const PORT_KEYS = ['OP_HOST_UI_PORT', 'OP_UI_PORT', 'OP_ASSISTANT_PORT', 'OP_WORKSPACE_PORT'];

  it('defaults to 3880/3800/3810/3820 when no env overrides are set', () => {
    const originals = PORT_KEYS.map((k) => [k, process.env[k]] as const);
    for (const [k] of originals) delete process.env[k];
    try {
      const targets = resolveInstallPortTargets();
      expect(targets.map((t) => t.port)).toEqual([3880, 3800, 3810, 3820]);
      // Only the workspace is non-blocking: losing it costs /advanced its
      // embedded OpenCode UI and nothing else, so it must not refuse an install.
      expect(targets.filter((t) => !t.blocking).map((t) => t.service)).toEqual(['workspace']);
    } finally {
      for (const [k, v] of originals) if (v !== undefined) process.env[k] = v;
    }
  });

  it('honors every port override', () => {
    const originals = PORT_KEYS.map((k) => [k, process.env[k]] as const);
    try {
      process.env.OP_HOST_UI_PORT = '4880';
      process.env.OP_UI_PORT = '4800';
      process.env.OP_ASSISTANT_PORT = '4810';
      process.env.OP_WORKSPACE_PORT = '4820';
      expect(resolveInstallPortTargets().map((t) => t.port)).toEqual([4880, 4800, 4810, 4820]);
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
  const composeProject = { name: 'openpalm', workingDir: '/tmp/op-home/system/stack' };

  it('marks a port held by our own container as available, not a conflict', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(65000, '127.0.0.1', () => resolve()));

    const client = fakeClient(async () =>
      okResult(`${composeProject.workingDir}\t127.0.0.1:65000->65000/tcp\n`),
    );
    const results = await probeInstallPorts(targets, { client, dockerAvailable: true, composeProject });

    expect(results[0]?.available).toBe(true);
    expect(results[0]?.ownership).toBe('held');
  });

  it('flags a genuinely foreign process on the port as a blocking conflict', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(65000, '127.0.0.1', () => resolve()));

    const client = fakeClient(async () =>
      okResult('/tmp/other-home/system/stack\t127.0.0.1:65000->65000/tcp\n'),
    );
    const results = await probeInstallPorts(targets, { client, dockerAvailable: true, composeProject });

    expect(results[0]?.available).toBe(false);
    expect(results[0]?.blocking).toBe(true);
  });

  it('downgrades a conflict to non-blocking when Docker is unreachable (can\'t verify ownership)', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(65000, '127.0.0.1', () => resolve()));

    const client = fakeClient(async () => okResult('irrelevant'));
    const results = await probeInstallPorts(targets, { client, dockerAvailable: false, composeProject });

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
