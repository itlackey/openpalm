import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));

function readRelative(path: string): string {
  return readFileSync(`${ROOT_DIR}/${path}`, 'utf8');
}

describe('portal image bake contract', () => {
  test('startup script no longer installs adapters at boot', () => {
    const startScript = readRelative('containers/portal/start.sh');

    expect(startScript).not.toContain('bun add');
    expect(startScript).toContain('PORTAL_PACKAGE must name a baked adapter package');
  });

  test('startup script runs under strict bash and guards optional vars', () => {
    const startScript = readRelative('containers/portal/start.sh');

    // Matches sibling entrypoints (voice/guardian/assistant) for fail-fast behaviour.
    expect(startScript).toContain('set -euo pipefail');
    expect(startScript).not.toMatch(/^set -e\s*$/m);
    // Under `-u`, the optional PORTAL_PACKAGE check must not trip on an unset var —
    // it must fall back to empty so the friendly error path still runs.
    expect(startScript).toContain('[ -z "${PORTAL_PACKAGE:-}" ]');
    expect(startScript).not.toContain('[ -z "$PORTAL_PACKAGE" ]');
  });

  test('docker image bakes the local SDK and first-party adapter candidates', () => {
    const dockerfile = readRelative('containers/portal/Dockerfile');

    expect(dockerfile).toContain('COPY packages/portal-sdk /opt/openpalm/local-src/portal-sdk');
    expect(dockerfile).toContain('COPY packages/portal-discord /opt/openpalm/local-src/packages/portal-discord');
    expect(dockerfile).toContain('COPY packages/portal-slack /opt/openpalm/local-src/packages/portal-slack');
    expect(dockerfile).toContain('bun pm pack');
    expect(dockerfile).toContain('bun add /opt/openpalm/local-artifacts/*.tgz --production');
    expect(dockerfile).toContain('COPY containers/portal/portal-entrypoint.ts /app/portal-entrypoint.ts');
    expect(dockerfile).not.toContain('containers/portal/tools/package.json');
  });

  test('managed portal compose uses baked package names, not dist-tags', () => {
    const compose = readRelative('packages/skeleton/system/stack/portals.compose.yml');

    expect(compose).not.toContain('@latest');
    expect(compose).toContain('PORTAL_PACKAGE: "@openpalm/discord-portal"');
    expect(compose).toContain('PORTAL_PACKAGE: "@openpalm/slack-portal"');
  });
});
