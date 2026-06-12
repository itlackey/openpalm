import { beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetState } from '$lib/server/test-helpers.js';
import { POST } from './+server.js';

describe('POST /api/setup/retry-deploy', () => {
  beforeEach(() => {
    process.env.PORT = '3880';
  });

  test('refuses once setup is complete', async () => {
    const state = resetState('pw');
    const envDir = join(state.stackDir, '..', '..', 'knowledge', 'env');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'stack.env'), 'OP_SETUP_COMPLETE=true\n');

    const response = await POST({} as never);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toBe('setup_complete');
  });
});
