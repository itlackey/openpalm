import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));

function readRelative(path: string): string {
  return readFileSync(`${ROOT_DIR}/${path}`, 'utf8');
}

describe('channel image bake contract', () => {
  test('startup script no longer installs adapters at boot', () => {
    const startScript = readRelative('core/channel/start.sh');

    expect(startScript).not.toContain('bun add');
    expect(startScript).toContain('CHANNEL_PACKAGE must name a baked adapter package');
  });

  test('docker image bakes the first-party adapters from the workspace', () => {
    const dockerfile = readRelative('core/channel/Dockerfile');

    expect(dockerfile).toContain('"packages/channels-sdk",');
    expect(dockerfile).toContain('COPY packages/channel-api /app/packages/channel-api');
    expect(dockerfile).toContain('COPY packages/channel-discord /app/packages/channel-discord');
    expect(dockerfile).toContain('COPY packages/channel-slack /app/packages/channel-slack');
    expect(dockerfile).toContain('RUN bun install --production');
  });

  test('managed channel compose uses baked package names, not dist-tags', () => {
    const compose = readRelative('.openpalm/config/stack/channels.compose.yml');

    expect(compose).not.toContain('@latest');
    expect(compose).toContain('CHANNEL_PACKAGE: "@openpalm/channel-api"');
    expect(compose).toContain('CHANNEL_PACKAGE: "@openpalm/channel-discord"');
    expect(compose).toContain('CHANNEL_PACKAGE: "@openpalm/channel-slack"');
  });
});
