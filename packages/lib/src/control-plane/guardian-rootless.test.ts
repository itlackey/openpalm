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
});
