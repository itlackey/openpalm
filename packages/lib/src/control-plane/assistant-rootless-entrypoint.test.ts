import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const assistantEntrypoint = readFileSync(join(REPO_ROOT, 'containers/assistant/entrypoint.sh'), 'utf8');

describe('assistant rootless entrypoint regressions', () => {
  test('runtime artifact installs use tmp-backed caches on the root pass', () => {
    expect(assistantEntrypoint).toContain('local root_npm_cache="/tmp/openpalm-npm-cache"');
    expect(assistantEntrypoint).toContain('local root_bun_cache="/tmp/openpalm-bun-cache/install"');
  });

  test('seed_default_agents_md hands bind-mounted AGENTS.md to the target uid', () => {
    expect(assistantEntrypoint).toContain('chown "$TARGET_UID:$TARGET_GID" "$dest"');
  });

  test('akm task sync runs as the target user when the container is still root', () => {
    expect(assistantEntrypoint).toContain('run_as_target_user akm tasks sync');
  });

  test('tool updates and install hooks run as the target user', () => {
    expect(assistantEntrypoint).toContain('run_as_target_user env BUN_INSTALL_CACHE_DIR="$root_bun_cache" bun update --cwd "${tools_dir}" --production');
    expect(assistantEntrypoint).toContain('run_as_target_user node "$claude_install"');
  });

  test('bun cache ownership repair targets the cache root, not only the install leaf', () => {
    expect(assistantEntrypoint).toContain('bun_cache_root="$(dirname "${BUN_INSTALL_CACHE_DIR:-/home/opencode/.cache/bun/install}")"');
  });
});
