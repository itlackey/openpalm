import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

beforeEach(() => {
  delete process.env.OP_CLIENT_PORT;
  delete process.env.OP_HOST_CLIENT_PORT;
});

afterEach(() => {
  delete process.env.OP_CLIENT_PORT;
  delete process.env.OP_HOST_CLIENT_PORT;
});

describe('openpalm app', () => {
  it('resolves the stable localhost client origin on the default port', async () => {
    const { resolveClientAppUrl } = await import('@openpalm/lib');

    expect(resolveClientAppUrl()).toBe('http://127.0.0.1:3890/chat');
  });

  it('uses OP_HOST_CLIENT_PORT and ignores OP_CLIENT_PORT collisions', async () => {
    process.env.OP_CLIENT_PORT = '4810';
    process.env.OP_HOST_CLIENT_PORT = '4890';
    const { resolveClientAppPort, resolveClientAppUrl } = await import('@openpalm/lib');

    expect(resolveClientAppPort()).toBe(4890);
    expect(resolveClientAppUrl()).toBe('http://127.0.0.1:4890/chat');
  });

  it('keeps the stable localhost origin when only OP_CLIENT_PORT is set', async () => {
    process.env.OP_CLIENT_PORT = '4810';
    const { resolveClientAppPort, resolveClientAppUrl } = await import('@openpalm/lib');

    expect(resolveClientAppPort()).toBe(3890);
    expect(resolveClientAppUrl()).toBe('http://127.0.0.1:3890/chat');
  });

  it('routes through the UI/client supervisor so the localhost app is served before opening', async () => {
    const calls: UIServerOptions[] = [];
    const mod = await import('./app.ts');

    await mod.runAppCommand(async (options) => {
      calls.push(options);
    });

    expect(calls).toEqual([{ openTarget: 'client' }]);
  });

  it('registers the app subcommand in the main command map', async () => {
    const { mainCommand } = await import('../main.ts');
    const sub = (mainCommand.subCommands as Record<string, () => Promise<unknown>>).app;
    expect(typeof sub).toBe('function');
    const cmd = (await sub()) as { meta?: { name?: string } };
    expect(cmd.meta?.name).toBe('app');
  });
});
