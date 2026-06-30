import { describe, it, expect, afterEach } from 'vitest';
import { checkHostHeader, checkOriginHeader, UI_PORT } from './helpers.js';

function req(host: string, init: { origin?: string; method?: string } = {}): Request {
  const headers: Record<string, string> = { host };
  if (init.origin) headers.origin = init.origin;
  return new Request('http://internal/admin/x', { method: init.method ?? 'GET', headers });
}

afterEach(() => {
  delete process.env.OP_ALLOW_REMOTE_SETUP;
});

describe('checkHostHeader', () => {
  it('allows loopback hosts on the server port', () => {
    expect(checkHostHeader(req(`localhost:${UI_PORT}`))).toBeNull();
    expect(checkHostHeader(req(`127.0.0.1:${UI_PORT}`))).toBeNull();
  });

  it('allows loopback hosts on a DIFFERENT port (SSH tunnel, e.g. -L 5880:localhost:3880)', () => {
    expect(checkHostHeader(req('localhost:5880'))).toBeNull();
    expect(checkHostHeader(req('127.0.0.1:9999'))).toBeNull();
  });

  it('rejects a non-loopback host by default', () => {
    const res = checkHostHeader(req('192.168.1.10:3880'));
    expect(res?.status).toBe(400);
  });

  it('allows any host when OP_ALLOW_REMOTE_SETUP is set', () => {
    process.env.OP_ALLOW_REMOTE_SETUP = '1';
    expect(checkHostHeader(req('192.168.1.10:3880'))).toBeNull();
  });
});

describe('checkOriginHeader', () => {
  it('allows GET regardless of origin', () => {
    expect(checkOriginHeader(req('192.168.1.10:3880', { method: 'GET' }))).toBeNull();
  });

  it('allows loopback origin on any port (tunnel)', () => {
    expect(
      checkOriginHeader(req('localhost:5880', { method: 'POST', origin: 'http://localhost:5880' })),
    ).toBeNull();
  });

  it('rejects a non-loopback POST origin by default', () => {
    const res = checkOriginHeader(
      req('192.168.1.10:3880', { method: 'POST', origin: 'http://192.168.1.10:3880' }),
    );
    expect(res?.status).toBe(403);
  });

  it('allows same-origin POST when OP_ALLOW_REMOTE_SETUP is set', () => {
    process.env.OP_ALLOW_REMOTE_SETUP = '1';
    expect(
      checkOriginHeader(req('192.168.1.10:3880', { method: 'POST', origin: 'http://192.168.1.10:3880' })),
    ).toBeNull();
  });
});
