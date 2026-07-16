import { describe, it, expect, afterEach } from 'vitest';
import { checkHostHeader, checkOriginHeader, UI_PORT } from './helpers.js';

function req(host: string, init: { origin?: string; method?: string; authorization?: string } = {}): Request {
  const headers: Record<string, string> = { host };
  if (init.origin) headers.origin = init.origin;
  if (init.authorization) headers.authorization = init.authorization;
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

  // PR #564 second retest: the rejection body must carry requestId (API contract).
  it('includes the passed requestId in the invalid_host body', async () => {
    const res = checkHostHeader(req('192.168.1.10:3880'), 'rid-host-123');
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { error: string; requestId?: string };
    expect(body.error).toBe('invalid_host');
    expect(body.requestId).toBe('rid-host-123');
  });
});

describe('checkOriginHeader', () => {
  it('allows GET regardless of origin', () => {
    expect(checkOriginHeader(req('192.168.1.10:3880', { method: 'GET' }))).toBeNull();
  });

  it('loopback-origin mode allows loopback origin on any port (tunnel)', () => {
    expect(
      checkOriginHeader(req('localhost:5880', { method: 'POST', origin: 'http://localhost:5880' }), 'loopback-origin'),
    ).toBeNull();
  });

  // PR #564 second retest: the rejection body must carry requestId (API contract).
  it('includes the passed requestId in the forbidden_origin body', async () => {
    const res = checkOriginHeader(
      req('192.168.1.10:3880', { method: 'POST', origin: 'http://evil.example' }),
      'loopback-origin',
      'rid-origin-456',
    );
    expect(res?.status).toBe(403);
    const body = (await res?.json()) as { error: string; requestId?: string };
    expect(body.error).toBe('forbidden_origin');
    expect(body.requestId).toBe('rid-origin-456');
  });

  it('loopback-origin mode rejects non-loopback POST origin by default', () => {
    const res = checkOriginHeader(
      req('192.168.1.10:3880', { method: 'POST', origin: 'http://192.168.1.10:3880' }),
      'loopback-origin',
    );
    expect(res?.status).toBe(403);
  });

  it('same-site mode allows matching host for non-loopback origin', () => {
    expect(
      checkOriginHeader(
        req('192.168.1.10:3880', { method: 'POST', origin: 'http://192.168.1.10:3880' }),
        'same-site',
      ),
    ).toBeNull();
  });

  it('same-site mode rejects mismatched host origin', () => {
    const res = checkOriginHeader(
      req('192.168.1.10:3880', { method: 'POST', origin: 'http://evil.example:3880' }),
      'same-site',
    );
    expect(res?.status).toBe(403);
  });

  it('allows same-origin POST when OP_ALLOW_REMOTE_SETUP is set (loopback-origin mode)', () => {
    process.env.OP_ALLOW_REMOTE_SETUP = '1';
    expect(
      checkOriginHeader(req('192.168.1.10:3880', { method: 'POST', origin: 'http://192.168.1.10:3880' }),
        'loopback-origin',
      ),
    ).toBeNull();
  });
});
