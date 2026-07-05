import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const assistantEntrypoint = readFileSync(join(REPO_ROOT, 'containers/assistant/entrypoint.sh'), 'utf8');

describe('assistant rootless entrypoint regressions', () => {
  test('runtime artifact installs cache under the persistent HOME for warm restarts', () => {
    // /home/opencode is the OP_HOME/data/assistant bind-mount, so caching here
    // survives container recreates and --prefer-offline actually hits a cache.
    expect(assistantEntrypoint).toContain('local npm_cache_dir="/home/opencode/.cache/openpalm-npm"');
    expect(assistantEntrypoint).toContain('local bun_cache_dir="/home/opencode/.cache/bun/install"');
    // The ephemeral /tmp caches defeated warm starts — they must be gone.
    expect(assistantEntrypoint).not.toContain('/tmp/openpalm-npm-cache');
    expect(assistantEntrypoint).not.toContain('/tmp/openpalm-bun-cache');
  });

  test('npm artifact install failures are surfaced, not swallowed', () => {
    expect(assistantEntrypoint).toContain('|| npm_rc="${PIPESTATUS[0]}"');
    expect(assistantEntrypoint).toContain('install failed (exit ${npm_rc})');
  });

  test('seed_default_agents_md only seeds the default file when absent', () => {
    expect(assistantEntrypoint).toContain('cp "$src" "$dest"');
  });

  test('akm task sync uses the rootless crontab wrapper path', () => {
    // The `$@` in the wrapper must be UNescaped inside the single-quoted printf
    // format: bash printf passes `\$` through literally, which would bake the
    // literal string `$@` into the wrapper and silently break crontab installs.
    expect(assistantEntrypoint).toContain("printf '#!/usr/bin/env sh\\nexec busybox crontab -c %s \"$@\"\\n'");
    expect(assistantEntrypoint).not.toContain('\\$@');
    expect(assistantEntrypoint).toContain('if ! run_akm_command akm tasks sync >&2; then');
  });

  test('akm health and task sync use the shared assistant-home wrapper', () => {
    expect(assistantEntrypoint).toContain('run_akm_command() {');
    expect(assistantEntrypoint).toContain('env HOME="${HOME:-/home/opencode}" "$@"');
    expect(assistantEntrypoint).toContain('run_akm_command akm health >&2 || rc=$?');
    expect(assistantEntrypoint).toContain('run_akm_command akm tasks sync >&2');
  });

  test('tool updates and install hooks run directly as the container user', () => {
    expect(assistantEntrypoint).toContain('BUN_INSTALL_CACHE_DIR="$bun_cache_dir" bun update --cwd "${tools_dir}" --production');
    expect(assistantEntrypoint).toContain('node "$claude_install"');
  });

  test('rootless assistant no longer mutates ownership before starting opencode', () => {
    expect(assistantEntrypoint).not.toContain('chown -R "$TARGET_UID:$TARGET_GID"');
  });

  test('rootless assistant synthesizes a passwd entry for arbitrary numeric uids', () => {
    expect(assistantEntrypoint).toContain('maybe_prepare_nss_wrapper');
    expect(assistantEntrypoint).toContain('NSS_WRAPPER_PASSWD');
  });

  test('nss_wrapper lookup globs fixed multiarch paths, not an unbounded recursive find', () => {
    // Walking the whole library tree on every boot is wasteful; resolve via the
    // known Debian multiarch glob instead.
    expect(assistantEntrypoint).toContain('/usr/lib/*/libnss_wrapper.so');
    expect(assistantEntrypoint).not.toContain('find /usr/lib /lib -name libnss_wrapper.so');
  });

  test('rootless assistant uses busybox crond with a user-owned spool mirror', () => {
    expect(assistantEntrypoint).toContain('local spool_dir="/tmp/openpalm-crontabs"');
    expect(assistantEntrypoint).toContain('local wrapper_dir="/tmp/openpalm-bin"');
    expect(assistantEntrypoint).toContain('crontab "$crontab_file" 2>/dev/null || true');
    expect(assistantEntrypoint).toContain('busybox crond -c "$spool_dir" -L /dev/stderr');
  });
});
