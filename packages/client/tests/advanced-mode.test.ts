import { describe, expect, test } from 'bun:test';
import type { ConnectionEntry } from '../src/lib/connections/index.ts';
import {
  buildAdvancedFrameUrl,
  buildAdvancedPath,
  buildChatPath,
  resolveAdvancedFrameUrl,
  resolveAdvancedTarget,
} from '../src/lib/advanced-mode.ts';

function connection(overrides: Partial<ConnectionEntry> = {}): ConnectionEntry {
  return {
    id: 'connection-1',
    label: 'Assistant',
    kind: 'remote-opencode',
    url: 'https://assistant.example',
    auth: { mode: 'none' },
    ...overrides,
  };
}

describe('resolveAdvancedTarget', () => {
  test('local-opencode targets its raw OpenCode URL', () => {
    expect(resolveAdvancedTarget(connection({ kind: 'local-opencode', url: 'http://127.0.0.1:3800' }))).toEqual({
      available: true,
      baseUrl: 'http://127.0.0.1:3800',
    });
  });

  test('remote-opencode targets the remote raw OpenCode URL', () => {
    expect(resolveAdvancedTarget(connection())).toEqual({
      available: true,
      baseUrl: 'https://assistant.example',
    });
  });

  test('openpalm-client-api is unavailable because Guardian does not expose the raw UI', () => {
    const result = resolveAdvancedTarget(
      connection({ kind: 'openpalm-client-api', url: 'https://home.example/oc', auth: { mode: 'basic', secretRef: 'secret' } })
    );
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('guardian-api');
      expect(result.message).toContain('does not expose the raw OpenCode web UI');
    }
  });

  test('credentialed local and remote OpenCode targets do not put secrets into iframe URLs', () => {
    for (const kind of ['local-opencode', 'remote-opencode'] as const) {
      const result = resolveAdvancedTarget(
        connection({ kind, auth: { mode: 'bearer', secretRef: 'encrypted-secret' } })
      );
      expect(result.available).toBe(false);
      if (!result.available) expect(result.reason).toBe('credentialed-opencode');
    }
  });

  test('refuses URLs that already carry userinfo or query credentials', () => {
    expect(resolveAdvancedTarget(connection({ url: 'https://user:password@example.com' })).available).toBe(false);
    expect(resolveAdvancedTarget(connection({ url: 'https://example.com?token=secret' })).available).toBe(false);
  });

  test('reports an HTTP remote frame as unavailable when the app runs over HTTPS', () => {
    const result = resolveAdvancedTarget(
      connection({ url: 'http://assistant.lan:4096' }),
      { protocol: 'https:', hostname: 'app.example' }
    );
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('mixed-content');
      expect(result.message).toMatch(/browser|HTTPS|mixed/i);
    }
  });
});

describe('advanced navigation and deep links', () => {
  test('preserves the selected session between chat and Advanced paths', () => {
    expect(buildAdvancedPath('session/one')).toBe('/advanced?session=session%2Fone');
    expect(buildChatPath('session/one')).toBe('/chat?session=session%2Fone');
  });

  test('builds the OpenCode session path from the real workspace without auth query parameters', () => {
    const url = buildAdvancedFrameUrl('https://assistant.example/', 'ses_1', '/work');
    expect(url).toBe('https://assistant.example/L3dvcms/session/ses_1');
    expect(url).not.toContain('?');
    expect(url).not.toContain('@');
  });

  test('session lookup omits browser credentials and sends no Authorization header', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return Response.json({ id: 'ses_1', directory: '/work' });
    }) as typeof fetch;

    const result = await resolveAdvancedFrameUrl('https://assistant.example', 'ses_1', fetchImpl);
    expect(result).toBe('https://assistant.example/L3dvcms/session/ses_1');
    expect(requestedUrl).toBe('https://assistant.example/session/ses_1');
    expect(requestedInit?.credentials).toBe('omit');
    expect(new Headers(requestedInit?.headers).has('authorization')).toBe(false);
  });
});
