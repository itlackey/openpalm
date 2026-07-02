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

  test('seed_default_agents_md only seeds the default file when absent', () => {
    expect(assistantEntrypoint).toContain('cp "$src" "$dest"');
  });

  test('akm task sync uses the rootless crontab wrapper path', () => {
    expect(assistantEntrypoint).toContain("printf '#!/usr/bin/env sh\\nexec busybox crontab -c %s \"\\$@\"\\n'");
    expect(assistantEntrypoint).toContain('if ! akm tasks sync >&2; then');
  });

  test('tool updates and install hooks run as the target user', () => {
    expect(assistantEntrypoint).toContain('run_as_target_user env BUN_INSTALL_CACHE_DIR="$root_bun_cache" bun update --cwd "${tools_dir}" --production');
    expect(assistantEntrypoint).toContain('run_as_target_user node "$claude_install"');
  });

  test('rootless assistant no longer mutates ownership before starting opencode', () => {
    expect(assistantEntrypoint).not.toContain('chown -R "$TARGET_UID:$TARGET_GID"');
  });

  test('rootless assistant synthesizes a passwd entry for arbitrary numeric uids', () => {
    expect(assistantEntrypoint).toContain('maybe_prepare_nss_wrapper');
    expect(assistantEntrypoint).toContain('NSS_WRAPPER_PASSWD');
  });

  test('rootless assistant uses busybox crond with a user-owned spool mirror', () => {
    expect(assistantEntrypoint).toContain('local spool_dir="/tmp/openpalm-crontabs"');
    expect(assistantEntrypoint).toContain('local wrapper_dir="/tmp/openpalm-bin"');
    expect(assistantEntrypoint).toContain('crontab "$crontab_file" 2>/dev/null || true');
    expect(assistantEntrypoint).toContain('busybox crond -c "$spool_dir" -L /dev/stderr');
  });
});
