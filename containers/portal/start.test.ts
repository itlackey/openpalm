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

  test('docker image bakes the first-party adapters from npm via tools/package.json', () => {
    const dockerfile = readRelative('containers/portal/Dockerfile');
    const tools = readRelative('containers/portal/tools/package.json');

    // Adapters are published npm packages installed at build time under
    // /opt/openpalm/tools — no workspace source is copied into the image.
    expect(dockerfile).toContain('COPY containers/portal/tools/package.json /opt/openpalm/tools/package.json');
    expect(dockerfile).toContain('bun install --cwd /opt/openpalm/tools --production');
    expect(dockerfile).toContain('COPY containers/portal/portal-entrypoint.ts /app/portal-entrypoint.ts');
    expect(dockerfile).not.toContain('COPY portals/discord');
    expect(dockerfile).not.toContain('COPY portals/slack');
    expect(dockerfile).not.toContain('workspaces');

    // The baked tools manifest declares the first-party adapter packages.
    expect(tools).toContain('@openpalm/discord-portal');
    expect(tools).toContain('@openpalm/slack-portal');
  });

  test('managed portal compose uses baked package names, not dist-tags', () => {
    const compose = readRelative('packages/skeleton/system/stack/portals.compose.yml');

    expect(compose).not.toContain('@latest');
    expect(compose).toContain('PORTAL_PACKAGE: "@openpalm/discord-portal"');
    expect(compose).toContain('PORTAL_PACKAGE: "@openpalm/slack-portal"');
  });
});
