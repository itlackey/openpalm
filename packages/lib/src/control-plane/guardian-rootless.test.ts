import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const portalsCompose = yamlParse(readFileSync(join(REPO_ROOT, 'packages/skeleton/system/stack/portals.compose.yml'), 'utf8')) as {
  services?: Record<string, { user?: string }>;
};
const guardianDockerfile = readFileSync(join(REPO_ROOT, 'containers/guardian/Dockerfile'), 'utf8');
const guardianEntrypoint = readFileSync(join(REPO_ROOT, 'containers/guardian/entrypoint.sh'), 'utf8');

describe('guardian rootless conversion', () => {
  test('guardian runs as the operator uid/gid in compose', () => {
    expect(portalsCompose.services?.guardian?.user).toBe('${OP_UID:-1000}:${OP_GID:-1000}');
  });

  test('guardian Dockerfile no longer ends as USER root', () => {
    expect(guardianDockerfile).not.toMatch(/^USER root$/m);
  });

  test('guardian entrypoint no longer re-execs through gosu', () => {
    expect(guardianEntrypoint).not.toContain('exec gosu');
  });

  test('guardian image uses the group-writable arbitrary-uid convention, not world-writable', () => {
    // Migration plan §5.1: g=u for arbitrary-uid write, NOT a+rwX.
    expect(guardianDockerfile).toContain('chmod -R g=u');
    expect(guardianDockerfile).not.toContain('a+rwX');
  });

  test('guardian trees are group-owned by the base user so g=u grants the runtime gid write', () => {
    // g=u only helps if the group is one the runtime gid belongs to: chown the
    // app trees to bun:bun (gid 1000 = default OP_GID) so the group-writable bit
    // is reachable by `--user ${OP_UID}:${OP_GID}`.
    expect(guardianDockerfile).toContain('chown -R bun:bun /opt/openpalm/guardian /opt/openpalm/skeleton /opt/openpalm/tools');
  });
});
