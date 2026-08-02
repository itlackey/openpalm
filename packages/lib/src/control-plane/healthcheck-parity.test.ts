/**
 * K6: healthcheck logic is defined twice — once baked into each Dockerfile
 * (governs a bare `docker run` / image-smoke path with no compose in front of
 * it) and once in the shipped compose files (governs the real stack, and wins
 * there since Compose's `healthcheck:` overrides the image's own). The two
 * had already drifted (assistant: 15s/3 retries vs 30s/5; guardian: 120s vs
 * 180s start_period) with only prose comments — never anything executable —
 * holding them together. This test parses both sides and fails the moment
 * they disagree again.
 *
 * The assistant's raw-env-password branch (Dockerfile only) is a deliberate,
 * documented exception — see containers/assistant/Dockerfile's own comment —
 * so this test compares the numeric thresholds, not the exact command text.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const STACK_DIR = join(REPO_ROOT, 'packages/skeleton/system/stack');

type ComposeHealthcheck = {
  test?: string | string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  start_period?: string;
};

type ComposeFile = {
  services?: Record<string, { healthcheck?: ComposeHealthcheck }>;
};

type DockerfileHealthcheck = {
  interval?: string;
  timeout?: string;
  startPeriod?: string;
  retries?: number;
};

/** Parse a single-line `HEALTHCHECK --flag=value ... CMD ...` directive. */
function parseDockerfileHealthcheck(dockerfile: string): DockerfileHealthcheck {
  const line = dockerfile.split('\n').find((l) => l.trim().startsWith('HEALTHCHECK '));
  if (!line) throw new Error('No HEALTHCHECK directive found');
  const flag = (name: string): string | undefined => line.match(new RegExp(`--${name}=(\\S+)`))?.[1];
  const retries = flag('retries');
  return {
    interval: flag('interval'),
    timeout: flag('timeout'),
    startPeriod: flag('start-period'),
    retries: retries === undefined ? undefined : Number(retries),
  };
}

function readCompose(path: string): ComposeFile {
  return yamlParse(readFileSync(path, 'utf-8')) as ComposeFile;
}

describe('Dockerfile HEALTHCHECK thresholds match the compose healthcheck they must mirror (K6)', () => {
  test('assistant: containers/assistant/Dockerfile vs core.compose.yml', () => {
    const dockerfileSource = readFileSync(join(REPO_ROOT, 'containers/assistant/Dockerfile'), 'utf-8');
    const dockerfile = parseDockerfileHealthcheck(dockerfileSource);
    const compose = readCompose(join(STACK_DIR, 'core.compose.yml')).services?.assistant?.healthcheck;
    expect(compose, 'core.compose.yml assistant service has no healthcheck').toBeDefined();

    expect(dockerfile.interval).toBe(compose?.interval);
    expect(dockerfile.timeout).toBe(compose?.timeout);
    expect(dockerfile.startPeriod).toBe(compose?.start_period);
    expect(dockerfile.retries).toBe(compose?.retries);

    const composeCommand = Array.isArray(compose?.test) ? compose.test.join(' ') : (compose?.test ?? '');
    for (const predicate of ['/run/openpalm/cron.pid', '/run/openpalm/user/task-sync-failed']) {
      expect(dockerfileSource).toContain(predicate);
      expect(composeCommand).toContain(predicate);
    }
    expect(composeCommand).toContain('test -r /run/openpalm/cron.pid || exit 1');
    expect(composeCommand).toContain('test ! -e /run/openpalm/user/task-sync-failed || exit 1');
    expect(composeCommand).not.toContain('openpalm-ui-skip');
    expect(dockerfileSource).not.toContain('openpalm-ui-skip');
  });

  test('guardian: containers/guardian/Dockerfile vs portals.compose.yml', () => {
    const dockerfile = parseDockerfileHealthcheck(
      readFileSync(join(REPO_ROOT, 'containers/guardian/Dockerfile'), 'utf-8'),
    );
    const compose = readCompose(join(STACK_DIR, 'portals.compose.yml')).services?.guardian?.healthcheck;
    expect(compose, 'portals.compose.yml guardian service has no healthcheck').toBeDefined();

    expect(dockerfile.interval).toBe(compose?.interval);
    expect(dockerfile.timeout).toBe(compose?.timeout);
    expect(dockerfile.startPeriod).toBe(compose?.start_period);
    expect(dockerfile.retries).toBe(compose?.retries);
  });
});
