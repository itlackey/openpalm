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

  test('docker image bakes the first-party adapters from the workspace', () => {
    const dockerfile = readRelative('containers/portal/Dockerfile');

    expect(dockerfile).toContain('COPY portals/discord /app/portals/discord');
    expect(dockerfile).toContain('COPY portals/slack /app/portals/slack');
    expect(dockerfile).toContain('COPY containers/portal/portal-entrypoint.ts /app/portal-entrypoint.ts');
    // Each adapter installs its OWN deps in place — no workspace root, no symlinked
    // package, no generated manifest (those left @openpalm/* unresolvable at runtime).
    expect(dockerfile).toContain('cd /app/portals/discord && bun install --production');
    expect(dockerfile).toContain('cd /app/portals/slack && bun install --production');
    expect(dockerfile).not.toContain('printf');
    expect(dockerfile).not.toContain('workspaces');
  });

  test('managed portal compose uses baked package names, not dist-tags', () => {
    const compose = readRelative('packages/skeleton/system/stack/portals.compose.yml');

    expect(compose).not.toContain('@latest');
    expect(compose).toContain('PORTAL_PACKAGE: "@openpalm/discord-portal"');
    expect(compose).toContain('PORTAL_PACKAGE: "@openpalm/slack-portal"');
  });
});
