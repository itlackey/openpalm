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

  test('guardian entrypoint defaults content validation on', () => {
    expect(guardianEntrypoint).toContain('enabled=1');
    expect(guardianEntrypoint).toContain('GUARDIAN_CONTENT_VALIDATION:-1');
    expect(guardianEntrypoint).not.toContain('GUARDIAN_CONTENT_VALIDATION:-0');
  });

  test('guardian app trees are world-writable for arbitrary-uid runtime install', () => {
    // The guardian runs as the host operator's ARBITRARY uid:gid. #585 retired
    // the `guardian-cache` named volume that used to sit over /opt/openpalm —
    // the image's own writable layer holds this content now, still built (and
    // chmod'd) at image ownership, not the operator's. g=u would only grant
    // write when OP_GID == 1000; world-writable is required for the explicit
    // downstream override install.
    // Secrets live in a separate 0600 bind-mount tree.
    // IMG-6 split the single install RUN in two so the heavy tools layer stays
    // cached across releases, so the chmod is now split too — the lower layer
    // must NOT chmod -R over /opt/openpalm, or it copies the whole cached tools
    // tree up into itself (measured: +790 MB). Assert the union of paths still
    // gets covered rather than one literal line. Verified against the built
    // image: all five are drwxrwxrwx.
    const chmodded = new Set(
      [...guardianDockerfile.matchAll(/chmod -R a\+rwX ([^\n\\]+)/g)].flatMap((m) =>
        m[1].trim().split(/\s+/),
      ),
    );
    for (const tree of [
      '/opt/openpalm',
      '/opt/openpalm/tools',
      '/opt/openpalm/guardian',
      '/opt/openpalm/guardian-pkg',
    ]) {
      expect(chmodded).toContain(tree);
    }
    expect(guardianDockerfile).not.toContain('chmod -R g=u');
  });
});
