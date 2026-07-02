import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const portalsComposePath = join(REPO_ROOT, 'packages/skeleton/system/stack/portals.compose.yml');
const portalStartPath = join(REPO_ROOT, 'containers/portal/start.sh');
const portalsCompose = yamlParse(readFileSync(portalsComposePath, 'utf8')) as {
  services?: Record<string, { user?: string }>;
};
const portalStart = readFileSync(portalStartPath, 'utf8');

describe('portal adapters rootless runtime identity', () => {
  for (const service of ['discord', 'slack']) {
    test(`${service} runs as the operator uid/gid`, () => {
      expect(portalsCompose.services?.[service]?.user).toBe('${OP_UID:-1000}:${OP_GID:-1000}');
    });
  }

  test('portal startup uses a writable tmp-backed HOME for arbitrary uid/gid', () => {
    expect(portalStart).toContain('export HOME="/tmp/openpalm-portal"');
    expect(portalStart).toContain('mkdir -p "$HOME"');
    expect(portalStart).toContain('export BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-$HOME/.cache/bun/install}"');
  });
});
