import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState } from '$lib/server/test-helpers.js';

const mocks = vi.hoisted(() => ({
  setProviderApiKey: vi.fn(),
  registerProvider: vi.fn(),
}));

vi.mock('$lib/server/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/helpers.js')>('$lib/server/helpers.js');
  return {
    ...actual,
    getOpenCodeClient: () => ({ setProviderApiKey: mocks.setProviderApiKey }),
  };
});

vi.mock('$lib/server/opencode/config.js', () => ({
  setProviderOptions: vi.fn(),
  setProviderEnabled: vi.fn(),
  setMainModel: vi.fn(),
  patchConfig: vi.fn(),
  getCurrentConfig: vi.fn(async () => ({ provider: {} })),
  registerProvider: mocks.registerProvider,
}));

import { PATCH } from './+server.js';
import { getState } from '$lib/server/state.js';

function makeEvent(body: unknown, providerId = 'custom-ai'): Parameters<typeof PATCH>[0] {
  const url = new URL(`http://localhost/api/host/providers/${providerId}`);
  return {
    params: { id: providerId },
    request: new Request(url, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: 'op_session=admin-token',
        'x-request-id': 'req-provider-patch',
      },
      body: JSON.stringify(body),
    }),
    url,
  } as Parameters<typeof PATCH>[0];
}

let rootDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_UI_HOST_MODE = 'host-ui';
  rootDir = join(tmpdir(), `openpalm-provider-patch-${randomBytes(4).toString('hex')}`);
  mkdirSync(rootDir, { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
  vi.clearAllMocks();
  mocks.registerProvider.mockResolvedValue({ alreadyExists: false });
  mocks.setProviderApiKey.mockResolvedValue({ ok: true, data: true });
});

afterEach(() => {
  delete process.env.OP_UI_HOST_MODE;
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

describe('PATCH /api/host/providers/[id]', () => {
  test('register-custom stores API keys only in OpenCode auth.json', async () => {
    const res = await PATCH(makeEvent({
      kind: 'register-custom',
      displayName: 'Custom AI',
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-custom-test',
    }));

    expect(res.status).toBe(200);
    expect(mocks.setProviderApiKey).toHaveBeenCalledWith('custom-ai', 'sk-custom-test');
    const state = getState();
    const stackEnvPath = join(state.stackDir, 'stack.env');
    if (existsSync(stackEnvPath)) {
      expect(readFileSync(stackEnvPath, 'utf-8')).not.toContain('CUSTOM_AI_API_KEY=sk-custom-test');
    }
    expect(existsSync(join(state.stackDir, 'secrets', 'custom_ai_api_key'))).toBe(false);
  });
});
