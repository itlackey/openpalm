import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const coreCompose = yamlParse(readFileSync(join(REPO_ROOT, 'packages/skeleton/system/stack/core.compose.yml'), 'utf8')) as {
  services?: Record<string, { user?: string }>;
};
const assistantDockerfile = readFileSync(join(REPO_ROOT, 'containers/assistant/Dockerfile'), 'utf8');
const assistantEntrypoint = readFileSync(join(REPO_ROOT, 'containers/assistant/entrypoint.sh'), 'utf8');

describe('assistant rootless conversion', () => {
  test('assistant runs as the operator uid/gid in compose', () => {
    expect(coreCompose.services?.assistant?.user).toBe('${OP_UID:-1000}:${OP_GID:-1000}');
  });

  test('assistant Dockerfile no longer depends on gosu or sudoers', () => {
    expect(assistantDockerfile).not.toContain('gosu');
    expect(assistantDockerfile).not.toContain('NOPASSWD');
  });

  test('assistant entrypoint no longer mutates passwd ids or re-execs through gosu', () => {
    expect(assistantEntrypoint).not.toContain('groupmod');
    expect(assistantEntrypoint).not.toContain('usermod');
    expect(assistantEntrypoint).not.toContain('gosu');
  });

  test('assistant seed dirs are world-writable so an arbitrary OP_UID can populate the cache volumes', () => {
    // The container runs as the host operator's ARBITRARY uid:gid (OP_UID:OP_GID,
    // not 1000), and Docker seeds a fresh named volume from the image path WITH
    // its ownership — so g=u (group = node, gid 1000) would NOT grant write on a
    // host whose gid != 1000. World-writable is the only image-side mode that
    // works for an arbitrary uid. Secrets live in a separate 0600 bind-mount tree.
    expect(assistantDockerfile).toContain('chmod -R a+rwX');
    expect(assistantDockerfile).not.toContain('chmod -R g=u');
  });

  test('assistant image does not recursively chmod the baked tools tree (no duplicate giant layer)', () => {
    // /opt/openpalm/tools holds the multi-hundred-MB node_modules + model cache
    // split across COPY layers; the seed-dir chmod must target the empty
    // skeleton dir, never bare /opt/openpalm (which would re-materialize the
    // whole tree).
    const chmodLine = assistantDockerfile.split('\n').find((l) => l.includes('chmod -R a+rwX'));
    expect(chmodLine).toBeDefined();
    expect(chmodLine).not.toMatch(/\/opt\/openpalm(\s|$)/);
    expect(chmodLine).not.toContain('/opt/openpalm/client');
    expect(chmodLine).toContain('/opt/openpalm/skeleton');
  });
});
