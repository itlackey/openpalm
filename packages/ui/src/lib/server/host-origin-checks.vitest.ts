import { describe, it, expect, afterEach } from 'vitest';
import { checkHostHeader, checkOriginHeader, UI_PORT } from './helpers.js';

function req(
  host: string,
  init: { origin?: string; method?: string; authorization?: string; protocol?: 'http' | 'https' } = {},
): Request {
  const headers: Record<string, string> = { host };
  if (init.origin) headers.origin = init.origin;
  if (init.authorization) headers.authorization = init.authorization;
  return new Request(`${init.protocol ?? 'http'}://internal/admin/x`, { method: init.method ?? 'GET', headers });
}

afterEach(() => {
  delete process.env.OP_ALLOW_REMOTE_SETUP;
  delete process.env.OP_UI_SERVED_IN_CONTAINER;
  delete process.env.OP_UI_BIND_ADDRESS;
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

  describe('the published container UI', () => {
    it('allows a LAN host when the container UI is published beyond loopback', () => {
      // The whole point of publishing it: a phone reaches it by name or IP.
      process.env.OP_UI_SERVED_IN_CONTAINER = '1';
      process.env.OP_UI_BIND_ADDRESS = '0.0.0.0';
      expect(checkHostHeader(req('openpalm.local:3800'))).toBeNull();
      expect(checkHostHeader(req('192.168.1.50:3800'))).toBeNull();
    });

    it('still rejects when the container UI is bound to loopback', () => {
      process.env.OP_UI_SERVED_IN_CONTAINER = '1';
      process.env.OP_UI_BIND_ADDRESS = '127.0.0.1';
      expect(checkHostHeader(req('openpalm.local:3800'))?.status).toBe(400);
    });

    it('does NOT relax for the host process, even with a stray bind address in its env', () => {
      // DNS rebinding targets loopback-bound services, so a bind address
      // leaking into a host operator's shell must never weaken the admin-
      // capable host UI. The container marker is required, not inferred.
      process.env.OP_UI_BIND_ADDRESS = '0.0.0.0';
      expect(checkHostHeader(req('192.168.1.50:3880'))?.status).toBe(400);
    });

    it('does NOT relax on the container marker alone', () => {
      process.env.OP_UI_SERVED_IN_CONTAINER = '1';
      expect(checkHostHeader(req('192.168.1.50:3800'))?.status).toBe(400);
    });
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

  it('allows a non-browser mutation with no Origin header', () => {
    expect(checkOriginHeader(req('localhost:3880', { method: 'POST' }))).toBeNull();
  });

  it('loopback-origin mode allows loopback origin on any port (tunnel)', () => {
    expect(
      checkOriginHeader(req('localhost:5880', { method: 'POST', origin: 'http://localhost:5880' }), 'loopback-origin'),
    ).toBeNull();
  });

  it('rejects a loopback origin on a different port', () => {
    const res = checkOriginHeader(
      req('localhost:3880', { method: 'POST', origin: 'http://localhost:5880' }),
      'loopback-origin',
    );
    expect(res?.status).toBe(403);
  });

  it('rejects a loopback origin with a different hostname or scheme', () => {
    expect(checkOriginHeader(
      req('127.0.0.1:3880', { method: 'POST', origin: 'http://localhost:3880' }),
      'loopback-origin',
    )?.status).toBe(403);
    expect(checkOriginHeader(
      req('localhost:3880', { method: 'POST', origin: 'https://localhost:3880' }),
      'loopback-origin',
    )?.status).toBe(403);
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

  it('same-site mode rejects the same hostname on another port', () => {
    const res = checkOriginHeader(
      req('192.168.1.10:3880', { method: 'POST', origin: 'http://192.168.1.10:5880' }),
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
