import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setPermissionRequestHandler: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      setPermissionRequestHandler: mocks.setPermissionRequestHandler,
      setPermissionCheckHandler: mocks.setPermissionCheckHandler,
    },
  },
  shell: { openExternal: vi.fn() },
  systemPreferences: {},
}));

import { configureMediaPermissions } from '../src/permissions.js';

type RequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (allowed: boolean) => void,
  details: { requestingUrl?: string },
) => void;

type CheckHandler = (webContents: unknown, permission: string, requestingOrigin?: string) => boolean;

beforeEach(() => {
  delete process.env.OP_HOST_UI_PORT;
  mocks.setPermissionRequestHandler.mockClear();
  mocks.setPermissionCheckHandler.mockClear();
  configureMediaPermissions();
});

afterEach(() => {
  delete process.env.OP_HOST_UI_PORT;
});

function requestAllowed(url: string, permission = 'media'): boolean {
  const handler = mocks.setPermissionRequestHandler.mock.calls[0]?.[0] as RequestHandler;
  let allowed = false;
  handler(null, permission, (value) => {
    allowed = value;
  }, { requestingUrl: url });
  return allowed;
}

function checkAllowed(url: string, permission = 'media'): boolean {
  const handler = mocks.setPermissionCheckHandler.mock.calls[0]?.[0] as CheckHandler;
  return handler(null, permission, url);
}

const REJECTED_ORIGINS = [
  'http://localhost.evil.example:3880',
  'http://127.0.0.1.evil.example:3880',
  'http://attacker@localhost:3880',
  'http://attacker@127.0.0.1:3880',
  'http://localhost:3881',
  'http://127.0.0.1',
  'https://localhost:3880',
  'file:///tmp/openpalm.html',
  'not a url',
];

describe('configureMediaPermissions request handler', () => {
  it('allows media only from the exact local UI hosts, protocol, and port', () => {
    expect(requestAllowed('http://127.0.0.1:3880/chat')).toBe(true);
    expect(requestAllowed('http://localhost:3880/advanced')).toBe(true);
    for (const origin of REJECTED_ORIGINS) expect(requestAllowed(origin), origin).toBe(false);
    expect(requestAllowed('http://127.0.0.1:3880/chat', 'notifications')).toBe(false);
  });

  // The port is resolved ONCE, at ../src/ui-port.js module load, and shared with
  // main.ts so the window's origin and this check cannot disagree — so the env
  // has to be set before the import, not mutated between calls. That is the
  // point rather than an inconvenience: re-resolving per request would let a
  // stack.env edit mid-session change which origin is trusted while the running
  // window stays on the old port.
  it('uses the configured local UI port rather than trusting every loopback port', async () => {
    process.env.OP_HOST_UI_PORT = '4999';
    vi.resetModules();
    const { configureMediaPermissions: configure } = await import('../src/permissions.js');
    mocks.setPermissionRequestHandler.mockClear();
    configure();
    const handler = mocks.setPermissionRequestHandler.mock.calls.at(-1)?.[0] as RequestHandler;
    const allowedFor = (url: string): boolean => {
      let allowed = false;
      handler(null, 'media', (value) => {
        allowed = value;
      }, { requestingUrl: url });
      return allowed;
    };
    expect(allowedFor('http://localhost:4999/chat')).toBe(true);
    expect(allowedFor('http://localhost:3880/chat')).toBe(false);
  });
});

describe('configureMediaPermissions check handler', () => {
  it('applies the same exact-origin policy as the request handler', () => {
    expect(checkAllowed('http://127.0.0.1:3880')).toBe(true);
    expect(checkAllowed('http://localhost:3880')).toBe(true);
    for (const origin of REJECTED_ORIGINS) expect(checkAllowed(origin), origin).toBe(false);
    expect(checkAllowed('http://localhost:3880', 'camera')).toBe(false);
  });
});
