import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const execFileAsync = promisify(execFile);
const ADMIN_URL = 'http://localhost:8100';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

type ContainerListResponse = {
  dockerContainers?: Array<{
    Service?: string;
    State?: string;
    Health?: string;
    Image?: string;
  }>;
};

test.describe('OpenViking Smoke', () => {
  const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
  test.skip(!!SKIP, 'Requires RUN_DOCKER_STACK_TESTS=1 and running compose stack');

  test('openviking container is present and healthy', async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/containers/list`, {
      headers: {
        'x-admin-token': ADMIN_TOKEN,
        'x-requested-by': 'test',
        'x-request-id': randomUUID(),
      },
    });

    expect(res.ok()).toBeTruthy();
    const data = (await res.json()) as ContainerListResponse;
    const openviking = data.dockerContainers?.find((container) => container.Service === 'openviking');

    expect(openviking).toBeDefined();
    expect(openviking?.State).toBe('running');
    expect(openviking?.Health).toBe('healthy');
    expect(openviking?.Image).toContain('ghcr.io/volcengine/openviking:v0.2.12');
  });

  test('openviking health responds and assistant receives addon env', async () => {
    const healthResult = await execFileAsync('docker', [
      'exec',
      'openpalm-openviking-1',
      'curl',
      '-sf',
      'http://localhost:1933/health',
    ]);
    const health = JSON.parse(healthResult.stdout.trim()) as { healthy?: boolean; version?: string };

    expect(health.healthy).toBe(true);
    expect(health.version).toBe('v0.2.12');

    const envResult = await execFileAsync('docker', [
      'inspect',
      '--format',
      '{{json .Config.Env}}',
      'openpalm-assistant-1',
    ]);
    const env = JSON.parse(envResult.stdout.trim()) as string[];

    expect(env).toContain('OPENVIKING_URL=http://openviking:1933');
    const apiKeyEntry = env.find((entry) => entry.startsWith('OPENVIKING_API_KEY='));
    expect(apiKeyEntry).toBeDefined();
    expect(apiKeyEntry).not.toBe('OPENVIKING_API_KEY=');
  });
});
