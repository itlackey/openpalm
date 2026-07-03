import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const guardianEntrypoint = readFileSync(join(REPO_ROOT, 'containers/guardian/entrypoint.sh'), 'utf8');

describe('guardian rootless entrypoint regressions', () => {
  test('artifact installs run directly as the container user (no privilege wrapper)', () => {
    expect(guardianEntrypoint).toContain('( cd "$prefix" && bun add "${pkg}@${version}" --production )');
    expect(guardianEntrypoint).toContain('bun update --cwd /opt/openpalm/tools --production');
    expect(guardianEntrypoint).not.toContain('run_as_target_user');
  });
});
