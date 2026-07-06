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

  test('cron preamble PATH derives from the boot PATH and keeps the tool venvs (#551)', () => {
    // The preamble PATH must not be a hardcoded subset of the image PATH —
    // that silently dropped /opt/assistant-tools/bin (apprise, used by the
    // `notify` skill) and /opt/google-cloud-sdk/bin, so scheduled tasks failed
    // with "apprise CLI not found" while exiting 0.
    expect(assistantEntrypoint).toContain('echo "PATH=$cron_path" >> "$crontab_file"');
    expect(assistantEntrypoint).toContain('for extra_dir in /opt/assistant-tools/bin /opt/google-cloud-sdk/bin; do');
    expect(assistantEntrypoint).not.toMatch(/echo "PATH=\$wrapper_dir:[^"]*" >> "\$crontab_file"/);
  });

  test('login-shell profile.d re-prepend keeps the tool venvs on PATH (#551)', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'containers/assistant/Dockerfile'), 'utf8');
    const profiled = dockerfile.split('\n').find((l) => l.includes('/etc/profile.d/openpalm-tools.sh') || l.includes('openpalm-tools.sh')) ?? '';
    const printfLine = dockerfile.match(/RUN printf 'export PATH="[^']*'/)?.[0] ?? '';
    expect(printfLine).toContain('/opt/assistant-tools/bin');
    expect(printfLine).toContain('/opt/google-cloud-sdk/bin');
    expect(profiled).toBeTruthy();
  });

  test('stashDir is persisted as a config fallback so a lost cron preamble cannot break akm (#552)', () => {
    // Cron jobs normally get AKM_STASH_DIR from the managed crontab preamble.
    // If an external crontab rewrite drops the preamble, akm must still find
    // the stash via config.json in the locations it resolves without env.
    expect(assistantEntrypoint).toContain('persist_akm_stash_dir_fallback() {');
    expect(assistantEntrypoint).toContain('local stash_dir="${AKM_STASH_DIR:-/stash}"');
    // Covers the passwd-home default busybox crond hands to jobs.
    expect(assistantEntrypoint).toContain('passwd_home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)"');
    // Existing configs are merged, never clobbered.
    expect(assistantEntrypoint).toContain('|| Array.isArray(cfg) || cfg.stashDir) process.exit(0);');
    // Wired into the boot sequence.
    expect(assistantEntrypoint).toMatch(/run_akm_schema_migration\npersist_akm_stash_dir_fallback\nstart_cron_and_sync_tasks/);
  });

  test('rootless assistant uses busybox crond with a user-owned spool mirror', () => {
    expect(assistantEntrypoint).toContain('local spool_dir="/tmp/openpalm-crontabs"');
    expect(assistantEntrypoint).toContain('local wrapper_dir="/tmp/openpalm-bin"');
    expect(assistantEntrypoint).toContain('crontab "$crontab_file" 2>/dev/null || true');
    expect(assistantEntrypoint).toContain('busybox crond -c "$spool_dir" -L /dev/stderr');
  });
});
