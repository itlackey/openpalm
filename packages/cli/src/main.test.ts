import { afterEach, describe, expect, it, mock } from 'bun:test';
import { main } from './main.ts';

describe('cli main', () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  });

  it('calls containers pull for update', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL) => {
      calls.push(String(input));
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    console.log = mock(() => {}) as typeof console.log;

    await main(['update']);

    expect(calls).toEqual(['http://localhost:8100/admin/containers/pull']);
  });

  it('throws for unknown command', async () => {
    await expect(main(['nope'])).rejects.toThrow('Unknown command: nope');
  });
});
