import { describe, expect, it } from 'bun:test';
import { DEFAULT_CLIENT_PORT, resolveClientAppPort, resolveClientAppUrl } from './client-app-url.ts';

describe('resolveClientAppPort', () => {
  it('defaults to the stable localhost app port', () => {
    expect(resolveClientAppPort({})).toBe(DEFAULT_CLIENT_PORT);
    expect(resolveClientAppUrl({})).toBe('http://127.0.0.1:3890/chat');
  });

  it('ignores the assistant container OP_CLIENT_PORT and only honors OP_HOST_CLIENT_PORT', () => {
    const env = {
      OP_CLIENT_PORT: '4810',
      OP_HOST_CLIENT_PORT: '4890',
    } satisfies NodeJS.ProcessEnv;
    expect(resolveClientAppPort(env)).toBe(4890);
    expect(resolveClientAppUrl(env)).toBe('http://127.0.0.1:4890/chat');
  });

  it('keeps the stable localhost app origin when only OP_CLIENT_PORT is set', () => {
    expect(resolveClientAppPort({ OP_CLIENT_PORT: '4810' })).toBe(DEFAULT_CLIENT_PORT);
    expect(resolveClientAppUrl({ OP_CLIENT_PORT: '4810' })).toBe('http://127.0.0.1:3890/chat');
  });
});
