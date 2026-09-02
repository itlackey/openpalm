/**
 * The assistant boot adopts akm-cli 0.9.9's boot contract for any bundler
 * (docs/plans/0.9.9-coordinated-release.md §1): pin an exact akm-cli, run
 * `akm migrate apply` at boot (offline, idempotent, takes its own safety
 * copies, applies every pending migration in one plan — including task
 * v2/v3 -> v4 conversion, now covering OPERATOR-authored files, not just the
 * shipped set), and read `akm health --format json`.
 *
 * This is a policy reversal from 0.13.0/0.13.1: those releases promised an
 * operator's own task files were "left exactly as they are" until the
 * operator ran `akm migrate apply` by hand. 0.13.2 runs it at every boot
 * instead — akm backs every rewritten file up under its own data dir first
 * and skips (never guesses at) a file it cannot convert deterministically,
 * naming it in the plan's `blockers`. These tests execute the real
 * entrypoint functions against a fake `akm`, so the new behavior is pinned
 * by what the shell actually does, not by prose.
 *
 * The second describe covers the #666 version-pin check
 * (`check_akm_version_pin`): a stale `/opt/openpalm` mount that shadows the
 * image-baked akm with an old one is reported as a boot marker instead of
 * surfacing only as a mystery `INVALID_CONFIG_FILE` from every akm
 * subcommand.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
const entrypoint = readFileSync(join(repoRoot, 'containers/assistant/entrypoint.sh'), 'utf8');

/** Pull one `name() { … }` definition out of the entrypoint, verbatim. */
function extractShellFunction(name: string): string {
  const match = entrypoint.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  if (!match) throw new Error(`entrypoint.sh no longer defines ${name}()`);
  return match[0];
}

const FAKE_AKM = `#!/usr/bin/env bash
printf 'akm %s\\n' "$*" >> "$AKM_CALL_LOG"
case "$1 \${2:-}" in
  "--version ")
    printf '%s\\n' "\${FAKE_VERSION:-0.9.9}"
    exit 0
    ;;
  "migrate apply")
    [ -n "\${FAKE_APPLY_JSON:-}" ] && printf '%s\\n' "$FAKE_APPLY_JSON"
    exit "\${FAKE_APPLY_RC:-0}"
    ;;
  "task sync") exit "\${FAKE_TASK_SYNC_RC:-0}" ;;
  "health ")
    [ -n "\${FAKE_HEALTH_ERR:-}" ] && printf '%s\\n' "$FAKE_HEALTH_ERR" >&2
    exit "\${FAKE_HEALTH_RC:-0}"
    ;;
  *) echo "fake akm: unexpected argv: $*" >&2; exit 99 ;;
esac
`;

type BootRun = { marker: string; calls: string[]; stderr: string };

/**
 * Run the REAL run_akm_migration_check (plus the helpers it calls) under the
 * entrypoint's own shell options, against a fake `akm` whose apply plan,
 * version, and exit codes the caller controls. `AKM_TOOLS_PACKAGE_JSON`
 * always points inside the sandbox tmpdir; omitting `packageJson` leaves that
 * path non-existent, so the version-pin check has nothing to compare against
 * and records nothing — matching a plain test/dev environment where
 * `/opt/openpalm` does not exist at all.
 */
function runMigrationCheck(env: {
  applyJson?: string;
  applyRc?: number;
  taskSyncRc?: number;
  healthRc?: number;
  healthErr?: string;
  version?: string;
  packageJson?: string;
}): BootRun {
  const dir = mkdtempSync(join(tmpdir(), 'akm-migrate-boot-'));
  const akmPath = join(dir, 'akm');
  const marker = join(dir, 'boot.status');
  const callLog = join(dir, 'calls.log');
  writeFileSync(akmPath, FAKE_AKM);
  chmodSync(akmPath, 0o755);
  writeFileSync(marker, '');
  writeFileSync(callLog, '');

  // Always a path under this tmpdir — non-existent by default, so the
  // version-pin check's "no pin resolved" branch is exercised the same way a
  // plain dev/test environment (no /opt/openpalm at all) would hit it.
  const packageJsonPath = join(dir, 'akm-pin-package.json');
  if (env.packageJson !== undefined) writeFileSync(packageJsonPath, env.packageJson);

  const script = [
    'set -euo pipefail',
    extractShellFunction('run_akm_command'),
    extractShellFunction('record_akm_boot_status'),
    extractShellFunction('check_akm_version_pin'),
    extractShellFunction('run_akm_migration_check'),
    'run_akm_migration_check',
  ].join('\n');

  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      AKM_BOOT_STATUS_FILE: marker,
      AKM_CALL_LOG: callLog,
      AKM_TOOLS_PACKAGE_JSON: packageJsonPath,
      FAKE_APPLY_JSON: env.applyJson ?? '',
      FAKE_APPLY_RC: String(env.applyRc ?? 0),
      FAKE_TASK_SYNC_RC: String(env.taskSyncRc ?? 0),
      FAKE_HEALTH_RC: String(env.healthRc ?? 0),
      FAKE_HEALTH_ERR: env.healthErr ?? '',
      FAKE_VERSION: env.version ?? '0.9.9',
    },
  });
  // The check is deliberately non-fatal (#474): whatever akm reports, the
  // function must return 0 so the assistant keeps booting.
  expect(result.status, result.stderr).toBe(0);
  const calls = readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
  return { marker: readFileSync(marker, 'utf8'), calls, stderr: result.stderr };
}

const CURRENT_PLAN = JSON.stringify({ schemaVersion: 1, status: 'current', blockers: [] });
const APPLIED_PLAN = JSON.stringify({
  schemaVersion: 1,
  status: 'current',
  blockers: [],
  applied: 1,
  taskV4Applied: 1,
  stateMigrations: { applied: [] },
});
const BLOCKED_PLAN = JSON.stringify({
  schemaVersion: 1,
  status: 'blocked',
  blockers: ['knowledge/tasks/legacy-argv.yml: argv-array-has-no-portable-shell-string'],
});

describe('assistant entrypoint — akm migrate apply boot flow', () => {
  it('applies once, syncs tasks, and probes health on a plan with nothing pending', () => {
    const run = runMigrationCheck({ applyJson: CURRENT_PLAN, applyRc: 0 });
    expect(run.marker).toBe('migrate 0 current\ntask-sync 0\nhealth 0\n');
    expect(run.calls).toEqual(['akm migrate apply', 'akm task sync --rebind', 'akm health']);
  });

  it('treats exit 0 with no plan printed as current (nothing to report)', () => {
    const run = runMigrationCheck({ applyJson: '', applyRc: 0 });
    expect(run.marker).toBe('migrate 0 current\ntask-sync 0\nhealth 0\n');
  });

  it('records `applied` when the plan reports files were converted — INCLUDING operator task files, never leaving them untouched', () => {
    const run = runMigrationCheck({ applyJson: APPLIED_PLAN, applyRc: 0 });
    expect(run.marker).toBe('migrate 0 applied\ntask-sync 0\nhealth 0\n');
    expect(run.calls).toEqual(['akm migrate apply', 'akm task sync --rebind', 'akm health']);
    // The policy reversal (B3): no promise that operator files are left alone,
    // and the log says the rewritten files were backed up.
    expect(run.stderr).not.toContain('leaves your files as written');
    expect(run.stderr).toContain('backed up');
  });

  it('records an unexpected exit-0 status verbatim instead of laundering it', () => {
    const run = runMigrationCheck({
      applyJson: JSON.stringify({ schemaVersion: 1, status: 'mystery' }),
      applyRc: 0,
    });
    expect(run.marker).toBe('migrate 0 mystery\ntask-sync 0\nhealth 0\n');
  });

  it('records unparseable exit-0 output without crashing', () => {
    const run = runMigrationCheck({ applyJson: 'not json at all', applyRc: 0 });
    expect(run.marker).toBe('migrate 0 unparseable\ntask-sync 0\nhealth 0\n');
  });

  it('records a blocked plan with the blocker count, and logs each blocker', () => {
    const run = runMigrationCheck({ applyJson: BLOCKED_PLAN, applyRc: 1 });
    expect(run.marker).toBe('migrate 1 blocked: 1\ntask-sync 0\nhealth 0\n');
    expect(run.calls).toEqual(['akm migrate apply', 'akm task sync --rebind', 'akm health']);
    expect(run.stderr).toContain('legacy-argv.yml: argv-array-has-no-portable-shell-string');
  });

  it('records a blocked plan with zero blockers named as blocked: 0 rather than crashing', () => {
    const run = runMigrationCheck({
      applyJson: JSON.stringify({ schemaVersion: 1, status: 'blocked', blockers: [] }),
      applyRc: 1,
    });
    expect(run.marker).toBe('migrate 1 blocked: 0\ntask-sync 0\nhealth 0\n');
  });

  it('records a crash exit as failed and keeps booting (never retries)', () => {
    const run = runMigrationCheck({ applyJson: '', applyRc: 70 });
    expect(run.marker).toBe('migrate 70 failed\ntask-sync 0\nhealth 0\n');
    // Exactly one apply call — the old double-apply retry is gone.
    expect(run.calls).toEqual(['akm migrate apply', 'akm task sync --rebind', 'akm health']);
  });

  it('runs task sync and health even when apply itself failed', () => {
    const run = runMigrationCheck({ applyJson: '', applyRc: 70, taskSyncRc: 3, healthRc: 4 });
    expect(run.marker).toBe('migrate 70 failed\ntask-sync 3\nhealth 4\n');
  });

  it('never calls `akm migrate status` — apply is the only migrate verb boot uses', () => {
    const run = runMigrationCheck({ applyJson: CURRENT_PLAN, applyRc: 0 });
    expect(run.calls.some((c) => c.includes('migrate status'))).toBe(false);
  });

  it('every akm task sync call passes --rebind (a test ratchet this file keeps)', () => {
    const run = runMigrationCheck({ applyJson: CURRENT_PLAN, applyRc: 0 });
    expect(run.calls).toContain('akm task sync --rebind');
  });

  it('the boot flow actually invokes the function these cases model', () => {
    expect(entrypoint).toMatch(/^run_akm_migration_check$/m);
  });
});

describe('assistant entrypoint — #666 akm version-pin check', () => {
  const PINNED_PACKAGE_JSON = JSON.stringify({ dependencies: { 'akm-cli': '0.9.9' } });

  it('records a match when the akm on PATH equals the image pin', () => {
    const run = runMigrationCheck({
      applyJson: CURRENT_PLAN,
      version: '0.9.9',
      packageJson: PINNED_PACKAGE_JSON,
    });
    expect(run.marker).toBe('akm-version 0\nmigrate 0 current\ntask-sync 0\nhealth 0\n');
    expect(run.calls[0]).toBe('akm --version');
  });

  it('records a mismatch and names both versions, without blocking boot', () => {
    const run = runMigrationCheck({
      applyJson: CURRENT_PLAN,
      version: '0.8.14',
      packageJson: PINNED_PACKAGE_JSON,
    });
    expect(run.marker).toBe('akm-version 1 0.8.14 expected 0.9.9\nmigrate 0 current\ntask-sync 0\nhealth 0\n');
    expect(run.stderr).toContain("akm --version reports '0.8.14'");
    expect(run.stderr).toContain('akm-cli 0.9.9');
    expect(run.stderr).toContain('stale /opt/openpalm mount');
  });

  it('checks the version BEFORE running migrate apply', () => {
    const run = runMigrationCheck({
      applyJson: CURRENT_PLAN,
      version: '0.8.14',
      packageJson: PINNED_PACKAGE_JSON,
    });
    expect(run.calls).toEqual(['akm --version', 'akm migrate apply', 'akm task sync --rebind', 'akm health']);
  });

  it('records nothing when no pin file is resolvable — no false positive', () => {
    // No `packageJson` fixture: AKM_TOOLS_PACKAGE_JSON stays at its real,
    // absent-in-this-sandbox default.
    const run = runMigrationCheck({ applyJson: CURRENT_PLAN });
    expect(run.marker).toBe('migrate 0 current\ntask-sync 0\nhealth 0\n');
    expect(run.calls.some((c) => c === 'akm --version')).toBe(false);
  });

  it('records nothing when the pin file has no akm-cli dependency', () => {
    const run = runMigrationCheck({
      applyJson: CURRENT_PLAN,
      packageJson: JSON.stringify({ dependencies: {} }),
    });
    expect(run.marker).toBe('migrate 0 current\ntask-sync 0\nhealth 0\n');
  });
});

describe('assistant entrypoint — the deleted state-upgrade reach-around stays deleted', () => {
  it('never mentions the removed helper or the old grep-on-error-text remedy', () => {
    expect(entrypoint).not.toContain('openpalm-akm-state-upgrade');
    expect(entrypoint).not.toContain('state-upgrade-pending');
    expect(entrypoint).not.toContain('Run `akm upgrade --force`');
    expect(entrypoint).not.toContain('upgrade --state-only');
  });

  it('the image no longer bakes the retired helper script', () => {
    const dockerfile = readFileSync(join(repoRoot, 'containers/assistant/Dockerfile'), 'utf8');
    expect(dockerfile).not.toContain('akm-state-upgrade');
    expect(dockerfile).not.toContain('openpalm-akm-state-upgrade');
  });
});
