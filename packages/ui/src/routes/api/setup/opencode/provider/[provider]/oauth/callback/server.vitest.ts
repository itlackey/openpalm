import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { completeProviderOAuth, resolveSetupOpencodeTarget } = vi.hoisted(() => ({
  completeProviderOAuth: vi.fn(),
  resolveSetupOpencodeTarget: vi.fn(),
}));

vi.mock('@openpalm/lib', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openpalm/lib')>();
  return {
    ...original,
    createOpenCodeClient: vi.fn(() => ({ completeProviderOAuth })),
  };
});
vi.mock('$lib/server/opencode/setup-target.js', () => ({ resolveSetupOpencodeTarget }));

import { POST } from './+server.js';

function event(provider: string, body: unknown, signal?: AbortSignal): Parameters<typeof POST>[0] {
  return {
    params: { provider },
    request: new Request(`http://127.0.0.1/api/setup/opencode/provider/${provider}/oauth/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
  } as Parameters<typeof POST>[0];
}

describe('POST setup OpenCode OAuth callback', () => {
  let home = '';
  let originalOpHome: string | undefined;
  let originalXdgDataHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    completeProviderOAuth.mockResolvedValue({ ok: true, data: { connected: true } });
    home = mkdtempSync(join(tmpdir(), 'openpalm-oauth-callback-'));
    originalOpHome = process.env.OP_HOME;
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.OP_HOME = home;
  });

  afterEach(() => {
    if (originalOpHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = originalOpHome;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('forwards an authorization code and merges only that wizard provider into canonical auth.json', async () => {
    const hostData = join(home, 'host-data');
    const hostAuthDir = join(hostData, 'opencode');
    mkdirSync(hostAuthDir, { recursive: true });
    writeFileSync(join(hostAuthDir, 'auth.json'), JSON.stringify({
      google: { type: 'api', key: 'oauth-method-result' },
      github: { type: 'oauth', access: 'unrelated-host-credential' },
    }));
    process.env.XDG_DATA_HOME = hostData;

    const canonicalDir = join(home, 'knowledge', 'secrets');
    const canonicalPath = join(canonicalDir, 'auth.json');
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(canonicalPath, JSON.stringify({
      groq: { type: 'api', key: 'keep-me' },
    }), { mode: 0o600 });
    const inode = statSync(canonicalPath).ino;

    resolveSetupOpencodeTarget.mockResolvedValue({ source: 'wizard', url: 'http://127.0.0.1:40123' });

    const callbackEvent = event('google', {
      method: 2,
      code: 'authorization-code',
      source: 'wizard',
    });
    const response = await POST(callbackEvent);

    expect(response.status).toBe(200);
    expect(resolveSetupOpencodeTarget).toHaveBeenCalledWith('wizard');
    expect(completeProviderOAuth).toHaveBeenCalledWith('google', 2, 'authorization-code', {
      timeoutMs: 9 * 60_000,
      signal: callbackEvent.request.signal,
    });
    expect(JSON.parse(readFileSync(canonicalPath, 'utf-8'))).toEqual({
      groq: { type: 'api', key: 'keep-me' },
      google: { type: 'api', key: 'oauth-method-result' },
    });
    expect(statSync(canonicalPath).ino).toBe(inode);
    expect(statSync(canonicalPath).mode & 0o777).toBe(0o600);
  });

  test('does not import host credentials when OAuth completed on the deployed assistant', async () => {
    const hostData = join(home, 'host-data');
    mkdirSync(join(hostData, 'opencode'), { recursive: true });
    writeFileSync(join(hostData, 'opencode', 'auth.json'), JSON.stringify({
      google: { type: 'oauth', access: 'wrong-host-value' },
    }));
    process.env.XDG_DATA_HOME = hostData;
    const canonicalPath = join(home, 'knowledge', 'secrets', 'auth.json');
    mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
    writeFileSync(canonicalPath, JSON.stringify({
      google: { type: 'oauth', access: 'assistant-owned-value' },
    }), { mode: 0o600 });
    resolveSetupOpencodeTarget.mockResolvedValue({ source: 'assistant', url: 'http://127.0.0.1:3810' });

    const response = await POST(event('google', { method: 0, source: 'assistant' }));

    expect(response.status).toBe(200);
    expect(JSON.parse(readFileSync(canonicalPath, 'utf-8'))).toEqual({
      google: { type: 'oauth', access: 'assistant-owned-value' },
    });
  });

  test('returns a callback failure without persisting a credential', async () => {
    completeProviderOAuth.mockResolvedValue({ ok: false, message: 'Code rejected' });
    resolveSetupOpencodeTarget.mockResolvedValue({ source: 'wizard', url: 'http://127.0.0.1:40123' });

    const response = await POST(event('google', { method: 0, code: 'bad-code', source: 'wizard' }));
    const body = await response.json() as { message: string };

    expect(response.status).toBe(400);
    expect(body.message).toBe('Code rejected');
  });

  test('rejects arbitrary target values without resolving or calling OpenCode', async () => {
    const response = await POST(event('google', {
      method: 0,
      source: 'http://attacker.test:4096',
    }));

    expect(response.status).toBe(400);
    expect(resolveSetupOpencodeTarget).not.toHaveBeenCalled();
    expect(completeProviderOAuth).not.toHaveBeenCalled();
  });

  test('honors an abort detected before completion without consuming the code', async () => {
    resolveSetupOpencodeTarget.mockResolvedValue({ source: 'wizard', url: 'http://127.0.0.1:40123' });

    const response = await POST(event('google', { method: 0, source: 'wizard' }, AbortSignal.abort()));
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('oauth_callback_aborted');
    expect(completeProviderOAuth).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'knowledge', 'secrets', 'auth.json'))).toBe(false);
  });

  test('an abort racing a successful completion still responds ok — the one-time code is consumed', async () => {
    const hostData = join(home, 'host-data');
    mkdirSync(join(hostData, 'opencode'), { recursive: true });
    writeFileSync(join(hostData, 'opencode', 'auth.json'), JSON.stringify({
      google: { type: 'api', key: 'completed-credential' },
    }));
    process.env.XDG_DATA_HOME = hostData;
    resolveSetupOpencodeTarget.mockResolvedValue({ source: 'wizard', url: 'http://127.0.0.1:40123' });

    const controller = new AbortController();
    const callbackEvent = event('google', { method: 0, source: 'wizard' }, controller.signal);
    completeProviderOAuth.mockImplementationOnce(async (
      _provider: string,
      _method: number,
      _code: string | undefined,
      options: { signal: AbortSignal },
    ) => {
      expect(options.signal).toBe(callbackEvent.request.signal);
      controller.abort();
      return { ok: true, data: { connected: true } };
    });

    const response = await POST(callbackEvent);

    // A 400 here would make the wizard retry a code the provider has already
    // consumed; the completed credential is persisted and reported as success.
    expect(response.status).toBe(200);
    expect(JSON.parse(readFileSync(join(home, 'knowledge', 'secrets', 'auth.json'), 'utf-8'))).toEqual({
      google: { type: 'api', key: 'completed-credential' },
    });
  });

  test('a persist failure after a successful OAuth reports oauth_credential_import_failed, not a generic 500', async () => {
    // Host store never received the credential: OAuth SUCCEEDED (the code is
    // consumed) but the import cannot find anything to copy. The generic catch
    // used to mask this as oauth_callback_failed, prompting a doomed retry.
    const hostData = join(home, 'host-data');
    mkdirSync(join(hostData, 'opencode'), { recursive: true });
    writeFileSync(join(hostData, 'opencode', 'auth.json'), JSON.stringify({}));
    process.env.XDG_DATA_HOME = hostData;
    resolveSetupOpencodeTarget.mockResolvedValue({ source: 'wizard', url: 'http://127.0.0.1:40123' });

    const response = await POST(event('google', { method: 0, source: 'wizard' }));
    const body = await response.json() as { error: string; message: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe('oauth_credential_import_failed');
    expect(body.message).toContain('google');
  });
});
