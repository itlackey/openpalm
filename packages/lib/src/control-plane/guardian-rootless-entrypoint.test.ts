import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const guardianEntrypoint = readFileSync(join(REPO_ROOT, 'containers/guardian/entrypoint.sh'), 'utf8');

describe('guardian rootless entrypoint regressions', () => {
  test('artifact installs run directly as the container user (no privilege wrapper)', () => {
    expect(guardianEntrypoint).toContain('( cd "$prefix" && bun add "${pkg}@${version}" --production )');
    // S.4: tools are exact-pinned now (containers/guardian/tools/package.json),
    // so boot no longer silently advances them within a semver range via
    // `bun update` — it runs a plain, idempotent `bun install` instead.
    expect(guardianEntrypoint).toContain('bun install --cwd /opt/openpalm/tools --production');
    expect(guardianEntrypoint).not.toContain('bun update --cwd /opt/openpalm/tools --production');
    expect(guardianEntrypoint).not.toContain('run_as_target_user');
  });
});
