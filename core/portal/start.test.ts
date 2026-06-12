import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));

function readRelative(path: string): string {
  return readFileSync(`${ROOT_DIR}/${path}`, 'utf8');
}

describe('portal image bake contract', () => {
  test('startup script no longer installs adapters at boot', () => {
    const startScript = readRelative('core/portal/start.sh');

    expect(startScript).not.toContain('bun add');
    expect(startScript).toContain('PORTAL_PACKAGE must name a baked adapter package');
  });

  test('docker image bakes the first-party adapters from the workspace', () => {
    const dockerfile = readRelative('core/portal/Dockerfile');

    expect(dockerfile).toContain('COPY packages/discord-portal /app/packages/discord-portal');
    expect(dockerfile).toContain('COPY packages/slack-portal /app/packages/slack-portal');
    expect(dockerfile).toContain('COPY core/portal/portal-entrypoint.ts /app/portal-entrypoint.ts');
    expect(dockerfile).toContain('RUN bun install --production');
  });

  test('managed portal compose uses baked package names, not dist-tags', () => {
    const compose = readRelative('.openpalm/config/stack/channels.compose.yml');

    expect(compose).not.toContain('@latest');
    expect(compose).toContain('PORTAL_PACKAGE: "@openpalm/discord-portal"');
    expect(compose).toContain('PORTAL_PACKAGE: "@openpalm/slack-portal"');
  });
});
