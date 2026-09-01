/**
 * The assistant boot must report akm's task-file migration state truthfully —
 * and must never rewrite operator task files while doing it.
 *
 * `akm migrate status` (akm-cli 0.9.6; byte-identical in 0.9.7) exits 0 for BOTH of its clean plan
 * states: "current" (nothing to convert) and "ready" (task files pending that
 * `akm migrate apply` would rewrite). Only a "blocked" plan earns exit 1
 * (dist/commands/migrate-cli.js sets the exit code iff the combined status is
 * "blocked"). The entrypoint used to read exit 0 as "current" unconditionally,
 * so a home with an operator-authored `version: 2` task recorded
 * `migrate 0 current` every boot while akm itself warned "run `akm migrate
 * apply`" every time it read the file — the marker contradicted the logs
 * forever.
 *
 * The fix parses the plan's `status` field. The one thing it must NOT do is
 * auto-apply: by boot time the only convertible files left are
 * operator-authored (`retirePreV4SeededTasks` already rewrote the shipped set
 * during the upgrade), and docs/managing-openpalm.md plus
 * docs/operations/upgrade-0.12-to-0.13.md ("Your own tasks are not rewritten")
 * promise those files stay as written until the operator converts them. These
 * tests execute the real entrypoint functions against a fake `akm`, so the
 * promise is pinned by behavior, not by prose.
 *
 * The second describe covers the health step's sibling contract: recognizing
 * akm's deliberate state.db cutover refusal (exit 78) and pointing at the
 * image-pinned `openpalm-akm-state-upgrade` helper — again reporting only,
 * never remediating at boot.
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
  "migrate status")
    [ -n "\${FAKE_STATUS_JSON:-}" ] && printf '%s\\n' "$FAKE_STATUS_JSON"
    exit "\${FAKE_STATUS_RC:-0}"
    ;;
  "migrate apply") exit "\${FAKE_APPLY_RC:-0}" ;;
  "task sync") exit 0 ;;
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
 * entrypoint's own shell options, against a fake `akm` whose status plan and
 * exit codes the caller controls.
 */
function runMigrationCheck(env: {
  statusJson?: string;
  statusRc?: number;
  applyRc?: number;
  healthRc?: number;
  healthErr?: string;
}): BootRun {
  const dir = mkdtempSync(join(tmpdir(), 'akm-migrate-boot-'));
  const akmPath = join(dir, 'akm');
  const marker = join(dir, 'boot.status');
  const callLog = join(dir, 'calls.log');
  writeFileSync(akmPath, FAKE_AKM);
  chmodSync(akmPath, 0o755);
  writeFileSync(marker, '');
  writeFileSync(callLog, '');

  const script = [
    'set -euo pipefail',
    extractShellFunction('run_akm_command'),
    extractShellFunction('record_akm_boot_status'),
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
      FAKE_STATUS_JSON: env.statusJson ?? '',
      FAKE_STATUS_RC: String(env.statusRc ?? 0),
      FAKE_APPLY_RC: String(env.applyRc ?? 0),
      FAKE_HEALTH_RC: String(env.healthRc ?? 0),
      FAKE_HEALTH_ERR: env.healthErr ?? '',
    },
  });
  // The check is deliberately non-fatal (#474): whatever akm reports, the
  // function must return 0 so the assistant keeps booting.
  expect(result.status, result.stderr).toBe(0);
  const calls = readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
  return { marker: readFileSync(marker, 'utf8'), calls, stderr: result.stderr };
}

const READY_PLAN = JSON.stringify({
  schemaVersion: 1,
  status: 'ready',
  blockers: [],
  taskV3Migration: { changed: 1, skipped: 4, blocked: 0 },
  taskV4Migration: { changed: 0, skipped: 5, blocked: 0 },
});

describe('assistant entrypoint — akm migrate boot check', () => {
  it('records `ready` truthfully and NEVER auto-applies over operator task files', () => {
    const run = runMigrationCheck({ statusJson: READY_PLAN, statusRc: 0 });
    expect(run.marker).toBe('migrate 0 ready operator-apply-pending\nhealth 0\n');
    expect(run.calls).toEqual(['akm migrate status', 'akm health']);
    // The log line must hand the operator the remedy the marker points at.
    expect(run.stderr).toContain("run 'akm migrate apply'");
  });

  it('records `current` when the plan says current', () => {
    const run = runMigrationCheck({
      statusJson: JSON.stringify({ schemaVersion: 1, status: 'current', blockers: [] }),
      statusRc: 0,
    });
    expect(run.marker).toBe('migrate 0 current\nhealth 0\n');
    expect(run.calls).toEqual(['akm migrate status', 'akm health']);
  });

  it('treats exit 0 with no plan as current (the CLI prints nothing when both generations have nothing to report)', () => {
    const run = runMigrationCheck({ statusJson: '', statusRc: 0 });
    expect(run.marker).toBe('migrate 0 current\nhealth 0\n');
  });

  it('records an unexpected exit-0 status verbatim instead of laundering it into current', () => {
    const run = runMigrationCheck({
      statusJson: JSON.stringify({ schemaVersion: 1, status: 'blocked' }),
      statusRc: 0,
    });
    expect(run.marker).toBe('migrate 0 blocked\nhealth 0\n');
    expect(run.calls).toEqual(['akm migrate status', 'akm health']);
  });

  it('records unparseable exit-0 output without touching anything', () => {
    const run = runMigrationCheck({ statusJson: 'not json at all', statusRc: 0 });
    expect(run.marker).toBe('migrate 0 unparseable\nhealth 0\n');
    expect(run.calls).toEqual(['akm migrate status', 'akm health']);
  });

  it('still runs the crash-resumable apply on a non-zero status exit', () => {
    const run = runMigrationCheck({ statusJson: '', statusRc: 1, applyRc: 0 });
    expect(run.marker).toBe('migrate 0 applied\ntask-sync 0\nhealth 0\n');
    expect(run.calls).toEqual([
      'akm migrate status',
      'akm migrate apply',
      'akm task sync --rebind',
      'akm health',
    ]);
  });

  it('records a failed apply as degraded (exit code preserved) and keeps booting', () => {
    const run = runMigrationCheck({ statusJson: '', statusRc: 1, applyRc: 7 });
    expect(run.marker).toBe('migrate 7 apply-failed\nhealth 0\n');
    // Retried once, never synced tasks, still probed health: boot went on.
    expect(run.calls).toEqual([
      'akm migrate status',
      'akm migrate apply',
      'akm migrate apply',
      'akm health',
    ]);
  });

  it('the boot flow actually invokes the function these cases model', () => {
    expect(entrypoint).toMatch(/^run_akm_migration_check$/m);
  });
});

/**
 * The health step's one canned remedy: akm refusing to open state.db until its
 * historical-destructive schema cutover is applied deliberately (`akm health`
 * exit 78). The advice inside akm's own message — `akm upgrade --force` — is
 * the package SELF-UPDATER and cannot work in the image-baked container
 * (GitHub egress + `npm install -g`), so boot must (a) recognize the refusal,
 * (b) point at the image-pinned helper that drives akm's cutover directly, and
 * (c) NEVER run the cutover itself: akm reserves this migration class for
 * explicit intent, and boot granting it automatically would extend that grant
 * to every future destructive migration an image bump ships.
 */
const STATE_UPGRADE_REFUSAL = JSON.stringify({
  ok: false,
  error:
    'Unable to open state.db: Refusing to apply historical destructive state migration ' +
    '018-drop-dead-lane-schema during an ordinary managed open. Run `akm upgrade --force` ' +
    'to create a sibling state.db safety copy and apply it deliberately.',
  code: 'INVALID_CONFIG_FILE',
});

describe('assistant entrypoint — akm health state-upgrade detection', () => {
  const CURRENT_PLAN = JSON.stringify({ schemaVersion: 1, status: 'current', blockers: [] });

  it('marks the pending deliberate cutover and points at the helper — without running it', () => {
    const run = runMigrationCheck({
      statusJson: CURRENT_PLAN,
      statusRc: 0,
      healthRc: 78,
      healthErr: STATE_UPGRADE_REFUSAL,
    });
    expect(run.marker).toBe('migrate 0 current\nhealth 78 state-upgrade-pending\n');
    // No remediation call of any kind — reporting only.
    expect(run.calls).toEqual(['akm migrate status', 'akm health']);
    expect(run.stderr).toContain('openpalm-akm-state-upgrade');
  });

  it('leaves other health failures undecorated', () => {
    const run = runMigrationCheck({
      statusJson: CURRENT_PLAN,
      statusRc: 0,
      healthRc: 70,
      healthErr: '{"ok": false, "error": "something else entirely"}',
    });
    expect(run.marker).toBe('migrate 0 current\nhealth 70\n');
    expect(run.stderr).not.toContain('openpalm-akm-state-upgrade');
  });

  it('the image bakes the helper the boot log names', () => {
    const dockerfile = readFileSync(join(repoRoot, 'containers/assistant/Dockerfile'), 'utf8');
    expect(dockerfile).toContain(
      'COPY containers/assistant/akm-state-upgrade.sh /usr/local/bin/openpalm-akm-state-upgrade',
    );
    expect(dockerfile).toContain('chmod +x /usr/local/bin/openpalm-akm-state-upgrade');
  });

  it('the helper drives akm state machinery directly and never the self-updater', () => {
    const helper = readFileSync(
      join(repoRoot, 'containers/assistant/akm-state-upgrade.sh'),
      'utf8',
    );
    expect(helper).toContain('upgradeHistoricalStateDatabase');
    // Comments may (and do) explain why `akm upgrade` is wrong; code must
    // never invoke it. Whole-line comment stripping mirrors the ratchet style
    // in image-baked-contract.test.ts.
    const codeLines = helper.split('\n').filter((l) => !/^\s*#/.test(l));
    expect(codeLines.filter((l) => /\bakm upgrade\b/.test(l))).toEqual([]);
  });
});
