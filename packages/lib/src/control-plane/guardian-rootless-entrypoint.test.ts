import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const guardianEntrypoint = readFileSync(join(REPO_ROOT, 'containers/guardian/entrypoint.sh'), 'utf8');

describe('guardian rootless entrypoint regressions', () => {
  test('artifact installs run as the target uid/gid instead of root', () => {
    expect(guardianEntrypoint).toContain('run_as_target_user env INSTALL_PREFIX="$prefix" PKG_SPEC="${pkg}@${version}" /bin/sh -lc');
    expect(guardianEntrypoint).toContain('run_as_target_user env TOOLS_DIR="/opt/openpalm/tools" /bin/sh -lc');
  });
});
