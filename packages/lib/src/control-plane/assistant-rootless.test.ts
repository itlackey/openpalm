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

  test('assistant image uses the group-writable arbitrary-uid convention, not world-writable', () => {
    // Migration plan §5.1: g=u (mirror owner to group) for arbitrary-uid write,
    // NOT a+rwX which would let any in-container uid rewrite persisted server code.
    expect(assistantDockerfile).toContain('chmod -R g=u');
    expect(assistantDockerfile).not.toContain('a+rwX');
  });

  test('assistant image does not recursively chmod the baked tools tree (no duplicate giant layer)', () => {
    // /opt/openpalm/tools holds the multi-hundred-MB node_modules + model cache
    // split across COPY layers; the seed-dir chmod must target the empty ui/skeleton
    // dirs, never bare /opt/openpalm (which would re-materialize the whole tree).
    const chmodLine = assistantDockerfile.split('\n').find((l) => l.includes('chmod -R g=u'));
    expect(chmodLine).toBeDefined();
    expect(chmodLine).not.toMatch(/\/opt\/openpalm(\s|$)/);
    expect(chmodLine).toContain('/opt/openpalm/ui');
    expect(chmodLine).toContain('/opt/openpalm/skeleton');
  });
});
