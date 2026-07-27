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

  test('guardian app trees are world-writable for arbitrary-uid runtime install', () => {
    // The guardian runs as the host operator's ARBITRARY uid:gid. #585 retired
    // the `guardian-cache` named volume that used to sit over /opt/openpalm —
    // the image's own writable layer holds this content now, still built (and
    // chmod'd) at image ownership, not the operator's. g=u would only grant
    // write when OP_GID == 1000; world-writable is required so the arbitrary
    // uid can `bun add` guardian/skeleton into /opt/openpalm on first boot.
    // Secrets live in a separate 0600 bind-mount tree.
    expect(guardianDockerfile).toContain('chmod -R a+rwX /opt/openpalm /opt/openpalm/guardian /opt/openpalm/guardian-pkg /opt/openpalm/skeleton /opt/openpalm/tools');
    expect(guardianDockerfile).not.toContain('chmod -R g=u');
  });
});
