import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const ENTRYPOINT = join(REPO_ROOT, 'containers/assistant/entrypoint.sh');
const MIGRATION_HELPER = join(REPO_ROOT, 'containers/assistant/migrate-akm-09.sh');
const PREPARE_CONFIG = join(REPO_ROOT, 'containers/assistant/prepare-akm-09-config.mjs');
const SMOKE_FIXTURE = join(REPO_ROOT, 'scripts/rootless-smoke-fixture.sh');
const HOST_SWAP_SMOKE = join(REPO_ROOT, 'scripts/rootless-host-swap-smoke.sh');
const OWNERSHIP_SMOKE = join(REPO_ROOT, 'scripts/rootless-ownership-smoke.sh');

function runSourcedScript(file: string, body: string, input = '') {
	return spawnSync('/bin/bash', ['-c', `source "$1"\n${body}`, '_', file], {
		encoding: 'utf8',
		input
	});
}

describe('assistant runtime shell behavior', () => {
	test('distinguishes a fresh native config from persisted migration phases', () => {
		const result = runSourcedScript(
			MIGRATION_HELPER,
			[
				'test "$(migration_phase_decision 0 \'\' 1 0.9.0)" = native',
				'test "$(migration_phase_decision 0 \'\' 1 0.8.0)" = start',
				'test "$(migration_phase_decision 1 apply 1 0.9.0)" = apply',
				'test "$(migration_phase_decision 1 post-apply 1 0.9.0)" = post-apply',
				'test "$(migration_phase_decision 1 post-apply 1 0.8.0)" = start',
				'test "$(migration_phase_decision 1 complete 1 \'\')" = start',
				'test "$(migration_phase_decision 1 complete 1 0.9.0)" = complete'
			].join('\n')
		);

		expect(result.status, result.stderr).toBe(0);
	});

	test('keeps persisted post-apply and complete phases when the live config is missing', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-missing-live-'));
		const configDir = join(root, 'config');
		const stateDir = join(root, 'state');
		const marker = join(stateDir, 'phase');
		const touched = join(root, 'post-apply-ran');
		mkdirSync(configDir);
		mkdirSync(stateDir);

		try {
			for (const phase of ['post-apply', 'complete']) {
				const phaseContent = `1|0.9.0|${phase}|0.9.0-rc.15\n`;
				writeFileSync(marker, phaseContent);
				rmSync(touched, { force: true });
				const result = runSourcedScript(
					MIGRATION_HELPER,
					[
						'NODE_BIN="$(command -v node)"',
						'require_assistant_identity() { :; }',
						'AKM_BIN=/bin/true',
						`AKM_CONFIG_DIR=${JSON.stringify(configDir)}`,
						`AKM_STATE_DIR=${JSON.stringify(stateDir)}`,
						`MIGRATION_PHASE_FILE=${JSON.stringify(marker)}`,
						'run_akm_command() { printf "%s\\n" 0.9.0-rc.15; }',
						`run_post_apply_steps() { : > ${JSON.stringify(touched)}; }`,
						`check_akm_health() { : > ${JSON.stringify(touched)}; }`,
						'set +e',
						'run_akm_09_migration',
						'rc=$?',
						'set -e',
						'test "$rc" -eq "$MIGRATION_FATAL_RC"'
					].join('\n')
				);

				expect(result.status, `${phase}: ${result.stderr}`).toBe(0);
				expect(result.stderr).toContain(`phase ${phase} requires a live 0.9.0 config`);
				expect(readFileSync(marker, 'utf8')).toBe(phaseContent);
				expect(existsSync(touched)).toBe(false);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('keeps a persisted phase when the live config is invalid', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-invalid-live-'));
		const configDir = join(root, 'config');
		const stateDir = join(root, 'state');
		const marker = join(stateDir, 'phase');
		const phaseContent = '1|0.9.0|post-apply|0.9.0-rc.15\n';
		mkdirSync(configDir);
		mkdirSync(stateDir);
		writeFileSync(join(configDir, 'config.json'), '{');
		writeFileSync(marker, phaseContent);

		try {
			const result = runSourcedScript(
				MIGRATION_HELPER,
				[
					'NODE_BIN="$(command -v node)"',
					'require_assistant_identity() { :; }',
					'AKM_BIN=/bin/true',
					`AKM_CONFIG_DIR=${JSON.stringify(configDir)}`,
					`AKM_STATE_DIR=${JSON.stringify(stateDir)}`,
					`MIGRATION_PHASE_FILE=${JSON.stringify(marker)}`,
					'run_akm_command() { printf "%s\\n" 0.9.0-rc.15; }',
					'set +e',
					'run_akm_09_migration',
					'rc=$?',
					'set -e',
					'test "$rc" -eq "$MIGRATION_FATAL_RC"'
				].join('\n')
			);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stderr).toContain('cannot parse live AKM config');
			expect(readFileSync(marker, 'utf8')).toBe(phaseContent);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('does not let a complete phase override a manually restored pre-0.9 config', () => {
		const result = runSourcedScript(
			MIGRATION_HELPER,
			'test "$(migration_phase_decision 1 complete 1 0.8.0)" = start'
		);

		expect(result.status, result.stderr).toBe(0);
	});

	test('rejects a forward live config without preparing or writing migration state', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-forward-'));
		const configDir = join(root, 'config');
		const stateDir = join(root, 'state');
		const touched = join(root, 'touched');
		mkdirSync(configDir);
		mkdirSync(stateDir);
		writeFileSync(join(configDir, 'config.json'), '{"configVersion":"1.0.0"}\n');

		try {
			const result = runSourcedScript(
				MIGRATION_HELPER,
				[
					'NODE_BIN="$(command -v node)"',
					'require_assistant_identity() { :; }',
					'AKM_BIN=/bin/true',
					`AKM_CONFIG_DIR=${JSON.stringify(configDir)}`,
					`AKM_STATE_DIR=${JSON.stringify(stateDir)}`,
					`MIGRATION_PHASE_FILE=${JSON.stringify(join(stateDir, 'phase'))}`,
					'run_akm_command() { printf "%s\\n" 0.9.0-rc.15; }',
					`prepare_new_migration() { : > ${JSON.stringify(touched)}; }`,
					'set +e',
					'run_akm_09_migration',
					'rc=$?',
					'set -e',
					'test "$rc" -eq "$MIGRATION_FATAL_RC"'
				].join('\n')
			);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stderr).toContain('unsupported live AKM config version 1.0.0');
			expect(existsSync(touched)).toBe(false);
			expect(existsSync(join(stateDir, 'phase'))).toBe(false);
			expect(existsSync(join(stateDir, 'openpalm-0.9-target.json'))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('retains post-apply after failure and retries without restore', () => {
		const result = runSourcedScript(
			MIGRATION_HELPER,
			[
				'AKM_MIGRATE_BIN=/bin/true',
				'ENTRYPOINT_BIN=/bin/true',
				'attempt=1',
				'run_akm_command() { if [ "$attempt" -eq 1 ]; then return 71; fi; }',
				'require_current_live_config() { :; }',
				'run_akm_index() { printf "index\\n"; }',
				'check_akm_health() { :; }',
				'write_migration_phase() { printf "phase=%s:%s\\n" "$1" "$2"; }',
				'set +e',
				'run_post_apply_steps 0.9.0-rc.15 /config.json',
				'first_rc=$?',
				'set -e',
				'test "$first_rc" -eq 71',
				'attempt=2',
				'run_post_apply_steps 0.9.0-rc.15 /config.json'
			].join('\n')
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe('index\nphase=complete:0.9.0-rc.15\n');
		expect(result.stderr).toContain('post-apply will retry on restart');
		expect(result.stderr).not.toContain('restore');
	});

	test('keeps skipped task reconciliation degraded without blocking completion', () => {
		const result = runSourcedScript(
			MIGRATION_HELPER,
			[
				'AKM_MIGRATE_BIN=/bin/true',
				'ENTRYPOINT_BIN=task_sync',
				'task_sync() { return 2; }',
				'run_akm_command() { :; }',
				'require_current_live_config() { :; }',
				'run_akm_index() { :; }',
				'check_akm_health() { :; }',
				'write_migration_phase() { printf "phase=%s:%s\\n" "$1" "$2"; }',
				'run_post_apply_steps 0.9.0-rc.15 /config.json'
			].join('\n')
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe('phase=complete:0.9.0-rc.15\n');
		expect(result.stderr).toContain('contains skipped tasks');
	});

	test('runs index through env/user only when the user env file exists', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-index-env-'));
		const envFile = join(root, 'user.env');
		writeFileSync(envFile, 'EXAMPLE=value\n');

		try {
			const result = runSourcedScript(
				MIGRATION_HELPER,
				[
					'AKM_BIN=/absolute/akm',
					`AKM_USER_ENV_FILE=${JSON.stringify(envFile)}`,
					'run_akm_command() { printf "%s" "$1"; shift; printf " %s" "$@"; printf "\\n"; }',
					'run_akm_index',
					`AKM_USER_ENV_FILE=${JSON.stringify(join(root, 'missing.env'))}`,
					'run_akm_index'
				].join('\n')
			);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stderr).toBe(
				'/absolute/akm env run env/user -- /absolute/akm index\n/absolute/akm index\n'
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('uses one outer migration deadline while preserving child exit status', () => {
		const migration = readFileSync(MIGRATION_HELPER, 'utf8');
		const entrypoint = readFileSync(ENTRYPOINT, 'utf8');
		const deadline = '/usr/bin/timeout --signal=TERM --kill-after=5s 2h';
		expect(migration.split(deadline)).toHaveLength(2);
		expect(migration).toContain(`exec ${deadline} \\`);
		expect(migration).toContain(`/bin/bash -c 'source "$1"; run_akm_09_migration' _ "$0"`);
		expect(entrypoint).not.toContain('run_akm_bootstrap_command');
		expect(entrypoint).toContain('"$AKM_MIGRATION_HELPER"');

		const result = runSourcedScript(
			MIGRATION_HELPER,
			[
				'set +e',
				'run_akm_command /bin/sh -c "exit 23"',
				'rc=$?',
				'set -e',
				'test "$rc" -eq 23'
			].join('\n')
		);
		expect(result.status, result.stderr).toBe(0);
		const boundedResult = spawnSync(
			'/usr/bin/timeout',
			['--signal=TERM', '--kill-after=5s', '2h', '/bin/sh', '-c', 'exit 23'],
			{ encoding: 'utf8' }
		);
		expect(boundedResult.status, boundedResult.stderr).toBe(23);
	});

	test('regenerates a torn prepared target before resuming apply', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-target-'));
		const configFile = join(root, 'config.json');
		const targetFile = join(root, 'target.json');
		writeFileSync(configFile, '{"configVersion":"0.8.0","stashDir":"/stash"}\n');
		writeFileSync(targetFile, '{');

		try {
			const result = runSourcedScript(
				MIGRATION_HELPER,
				[
					'NODE_BIN="$(command -v node)"',
					`PREPARE_CONFIG_BIN=${JSON.stringify(PREPARE_CONFIG)}`,
					'AKM_BIN=/absolute/akm',
					'run_akm_command() { printf "%s" "$1"; shift; printf " %s" "$@"; printf "\\n"; }',
					'require_current_live_config() { :; }',
					'write_migration_phase() { printf "phase=%s:%s\\n" "$1" "$2"; }',
					'run_post_apply_steps() { printf "post=%s\\n" "$1"; }',
					`resume_migration_apply ${JSON.stringify(configFile)} ${JSON.stringify(targetFile)} 0.9.0-rc.15`
				].join('\n')
			);

			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(readFileSync(targetFile, 'utf8')).configVersion).toBe('0.9.0');
			expect(result.stderr).toContain(`/absolute/akm migrate apply --config ${targetFile}`);
			expect(result.stdout).toContain('phase=post-apply:0.9.0-rc.15');
			expect(readdirSync(root).some((entry) => entry.includes('.tmp'))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('persists post-apply but blocks it when apply leaves an old live config', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-apply-old-live-'));
		const configFile = join(root, 'config.json');
		const targetFile = join(root, 'target.json');
		const phaseFile = join(root, 'phase');
		writeFileSync(configFile, '{"configVersion":"0.8.0","stashDir":"/stash"}\n');

		try {
			const result = runSourcedScript(
				MIGRATION_HELPER,
				[
					'NODE_BIN="$(command -v node)"',
					`PREPARE_CONFIG_BIN=${JSON.stringify(PREPARE_CONFIG)}`,
					`MIGRATION_PHASE_FILE=${JSON.stringify(phaseFile)}`,
					'AKM_BIN=/absolute/akm',
					'run_akm_command() { :; }',
					'set +e',
					`resume_migration_apply ${JSON.stringify(configFile)} ${JSON.stringify(targetFile)} 0.9.0-rc.15`,
					'rc=$?',
					'set -e',
					'test "$rc" -eq "$MIGRATION_FATAL_RC"'
				].join('\n')
			);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stderr).toContain('requires exact live config version 0.9.0; got 0.8.0');
			expect(readFileSync(phaseFile, 'utf8')).toBe('1|0.9.0|post-apply|0.9.0-rc.15\n');
			expect(JSON.parse(readFileSync(configFile, 'utf8')).configVersion).toBe('0.8.0');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('reuses one bounded preflight stage until every copy succeeds', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-preflight-'));
		const stateDir = join(root, 'state');
		const dataDir = join(root, 'data');
		const configFile = join(root, 'config.json');
		const backupDir = join(stateDir, 'openpalm-pre-0.9-missing-version');
		mkdirSync(stateDir);
		mkdirSync(dataDir);
		writeFileSync(configFile, '{"profiles":{}}\n');
		writeFileSync(join(dataDir, 'state.db'), 'state-before');
		writeFileSync(join(dataDir, 'workflow.db'), 'workflow-before');

		try {
			const interrupt = () =>
				runSourcedScript(
					MIGRATION_HELPER,
					[
						'NODE_BIN="$(command -v node)"',
						`AKM_STATE_DIR=${JSON.stringify(stateDir)}`,
						`AKM_DATA_DIR=${JSON.stringify(dataDir)}`,
						'copy_count=0',
						'cp() {',
						'  copy_count=$((copy_count + 1))',
						'  /bin/cp "$@"',
						'  if [ "$copy_count" -eq 2 ]; then return 71; fi',
						'}',
						'set +e',
						`ensure_missing_version_preflight_backup ${JSON.stringify(configFile)}`,
						'rc=$?',
						'set -e',
						'test "$rc" -eq "$MIGRATION_FATAL_RC"'
					].join('\n')
				);

			const interrupted = interrupt();
			expect(interrupted.status, interrupted.stderr).toBe(0);
			expect(interrupt().status).toBe(0);
			expect(existsSync(backupDir)).toBe(false);
			expect(readdirSync(stateDir)).toEqual(['openpalm-pre-0.9-missing-version.stage']);

			const retried = runSourcedScript(
				MIGRATION_HELPER,
				[
					'NODE_BIN="$(command -v node)"',
					`AKM_STATE_DIR=${JSON.stringify(stateDir)}`,
					`AKM_DATA_DIR=${JSON.stringify(dataDir)}`,
					`ensure_missing_version_preflight_backup ${JSON.stringify(configFile)}`
				].join('\n')
			);

			expect(retried.status, retried.stderr).toBe(0);
			expect(readFileSync(join(backupDir, 'config.json'), 'utf8')).toBe('{"profiles":{}}\n');
			expect(readFileSync(join(backupDir, 'state.db'), 'utf8')).toBe('state-before');
			expect(readFileSync(join(backupDir, 'workflow.db'), 'utf8')).toBe('workflow-before');
			expect(readFileSync(join(backupDir, '.complete'), 'utf8')).toBe('1|0.9.0\n');
			expect(existsSync(`${backupDir}.stage`)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('rejects a symlinked preflight stage without writing through it', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-preflight-link-'));
		const stateDir = join(root, 'state');
		const dataDir = join(root, 'data');
		const configFile = join(root, 'config.json');
		const stageDir = join(stateDir, 'openpalm-pre-0.9-missing-version.stage');
		mkdirSync(stateDir);
		mkdirSync(dataDir);
		writeFileSync(configFile, '{"profiles":{}}\n');
		symlinkSync(dataDir, stageDir, 'dir');

		try {
			const result = runSourcedScript(
				MIGRATION_HELPER,
				[
					'NODE_BIN="$(command -v node)"',
					`AKM_STATE_DIR=${JSON.stringify(stateDir)}`,
					`AKM_DATA_DIR=${JSON.stringify(dataDir)}`,
					'set +e',
					`ensure_missing_version_preflight_backup ${JSON.stringify(configFile)}`,
					'rc=$?',
					'set -e',
					'test "$rc" -eq "$MIGRATION_FATAL_RC"'
				].join('\n')
			);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stderr).toContain('stage must be a regular directory');
			expect(readdirSync(dataDir)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('resumes post-apply work even when the live config is already current', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-current-live-'));
		writeFileSync(join(root, 'config.json'), '{"configVersion":"0.9.0"}\n');

		try {
			const result = runSourcedScript(
				MIGRATION_HELPER,
				[
					'require_assistant_identity() { :; }',
					'AKM_BIN=/bin/true',
					`AKM_CONFIG_DIR=${JSON.stringify(root)}`,
					'run_akm_command() { printf "%s\\n" 0.9.0-rc.15; }',
					'read_config_version() { printf "%s\\n" 0.9.0; }',
					'load_migration_phase() {',
					'  MIGRATION_PHASE=post-apply',
					'  MIGRATION_PHASE_AKM_VERSION=0.9.0-rc.15',
					'  return 0',
					'}',
					'run_post_apply_steps() { printf "%s\\n" "$1"; }',
					'check_akm_health() { return 99; }',
					'run_akm_09_migration'
				].join('\n')
			);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toBe('0.9.0-rc.15\n');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('refuses pre-existing smoke homes and projects outside guarded prefixes', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-smoke-guard-'));
		const home = join(root, '.rootless-smoke-stack-1234');
		const marker = join(home, 'operator-data');
		mkdirSync(home);
		writeFileSync(marker, 'retain\n');

		try {
			const result = runSourcedScript(
				SMOKE_FIXTURE,
				[
					'set -e',
					'set +e',
					`smoke_create_guarded_home ${JSON.stringify(root)} ${JSON.stringify(home)} .rootless-smoke-stack TEST_HOME`,
					'home_rc=$?',
					'set -e',
					'test "$home_rc" -ne 0',
					'test "$(smoke_guarded_project openpalm-rootless-smoke-stack-1234 openpalm-rootless-smoke-stack TEST_PROJECT)" = openpalm-rootless-smoke-stack-1234',
					'set +e',
					'smoke_guarded_project unrelated-project openpalm-rootless-smoke-stack TEST_PROJECT >/dev/null',
					'project_rc=$?',
					'set -e',
					'test "$project_rc" -ne 0'
				].join('\n')
			);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stderr).toContain('Refusing to replace an existing smoke path');
			expect(result.stderr).toContain('must use the guarded openpalm-rootless-smoke-stack prefix');
			expect(readFileSync(marker, 'utf8')).toBe('retain\n');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('project preflight refuses labelled resources without issuing cleanup commands', () => {
		const result = runSourcedScript(
			SMOKE_FIXTURE,
			[
				'set -e',
				'timeout() { shift; "$@"; }',
				'docker() {',
				'  if [[ "$1" == rm || "$*" == *" down "* ]]; then return 99; fi',
				'  case "$*" in',
				'    "ps -aq --filter label=com.docker.compose.project=openpalm-rootless-smoke-stack-1234") printf "%s\\n" existing-container ;;',
				'  esac',
				'}',
				'set +e',
				'smoke_assert_project_absent openpalm-rootless-smoke-stack-1234',
				'rc=$?',
				'set -e',
				'test "$rc" -ne 0'
			].join('\n')
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain('Refusing to reset pre-existing Docker resources');
		expect(result.stderr).toContain('existing-container');
	});

	test('bounds smoke compose cleanup and arms host-swap teardown before the first start', () => {
		const hostSwap = readFileSync(HOST_SWAP_SMOKE, 'utf8');
		const ownership = readFileSync(OWNERSHIP_SMOKE, 'utf8');
		const boundedDown = 'timeout --signal=TERM --kill-after=5s 60s "${DEV_COMPOSE[@]}"';

		expect(hostSwap).toContain(boundedDown);
		expect(ownership).toContain(boundedDown);
		expect(hostSwap.indexOf('SWAP_PROJECT_CREATED=1')).toBeLessThan(
			hostSwap.indexOf('if swap_error=')
		);
		for (const script of [hostSwap, ownership]) {
			expect(script.indexOf('smoke_remove_project_resources')).toBeGreaterThan(
				script.indexOf(boundedDown)
			);
			expect(script).toContain('retaining $');
			expect(script).toContain('because Docker resources could not be proven absent');
		}
	});

	test('rejects a non-node migration helper identity', () => {
		const result = runSourcedScript(
			MIGRATION_HELPER,
			[
				'id() { printf "%s\\n" intruder; }',
				'set +e',
				'require_assistant_identity',
				'rc=$?',
				'set -e',
				'test "$rc" -eq 70'
			].join('\n')
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain('must run as the configured node account');
	});

	test('propagates a failed reconciliation status write as fatal', () => {
		const result = runSourcedScript(
			ENTRYPOINT,
			[
				'set_task_sync_status() { return "$TASK_SYNC_MONITOR_FATAL_RC"; }',
				'set +e',
				'record_reconciliation_result 1',
				'rc=$?',
				'set -e',
				'test "$rc" -eq "$TASK_SYNC_MONITOR_FATAL_RC"',
				'TASK_SYNC_STATUS_FILE=/definitely-missing-openpalm-test/status',
				'set +e',
				'write_task_sync_status_file degraded exit-1',
				'rc=$?',
				'set -e',
				'test "$rc" -eq "$TASK_SYNC_MONITOR_FATAL_RC"'
			].join('\n')
		);

		expect(result.status, result.stderr).toBe(0);
	});

	test('records bounded reconciliation reasons without persisting command output', () => {
		const result = runSourcedScript(
			ENTRYPOINT,
			[
				'set_task_sync_status() { printf "%s %s\\n" "$1" "$2"; }',
				'record_reconciliation_result 0',
				'set +e',
				'record_reconciliation_result 2',
				'skipped_rc=$?',
				'record_reconciliation_result 124',
				'exit_rc=$?',
				'set -e',
				'test "$skipped_rc" -eq 1',
				'test "$exit_rc" -eq 1'
			].join('\n')
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe('healthy ok\ndegraded skipped\ndegraded exit-124\n');
	});

	test('accepts only a fresh canonical healthy reconciliation status', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-task-sync-health-'));
		const statusFile = join(root, 'task-sync.status');

		try {
			const result = runSourcedScript(
				ENTRYPOINT,
				[
					`TASK_SYNC_STATUS_FILE=${JSON.stringify(statusFile)}`,
					'TASK_SYNC_STATUS_MAX_AGE_SECONDS=90',
					'assert_unhealthy() { if task_sync_status_is_healthy 1000; then return 1; fi; }',
					'printf "healthy 910 ok\\n" > "$TASK_SYNC_STATUS_FILE"',
					'task_sync_status_is_healthy 1000',
					'printf "healthy 909 ok\\n" > "$TASK_SYNC_STATUS_FILE"',
					'assert_unhealthy',
					'printf "degraded 1000 skipped\\n" > "$TASK_SYNC_STATUS_FILE"',
					'assert_unhealthy',
					'printf "degraded 1000 exit-124\\n" > "$TASK_SYNC_STATUS_FILE"',
					'assert_unhealthy',
					'printf "healthy 1000 skipped\\n" > "$TASK_SYNC_STATUS_FILE"',
					'assert_unhealthy',
					'printf "degraded 1000 exit-0\\n" > "$TASK_SYNC_STATUS_FILE"',
					'assert_unhealthy',
					'printf "degraded 1000 exit-01\\n" > "$TASK_SYNC_STATUS_FILE"',
					'assert_unhealthy',
					'printf "degraded 1000 exit-256\\n" > "$TASK_SYNC_STATUS_FILE"',
					'assert_unhealthy',
					'printf "healthy\\n" > "$TASK_SYNC_STATUS_FILE"',
					'assert_unhealthy',
					'printf "healthy 1001 ok\\n" > "$TASK_SYNC_STATUS_FILE"',
					'assert_unhealthy',
					'printf "healthy 01000 ok\\n" > "$TASK_SYNC_STATUS_FILE"',
					'assert_unhealthy',
					'printf "healthy 1000 ok extra\\n" > "$TASK_SYNC_STATUS_FILE"',
					'assert_unhealthy',
					'printf "healthy 1000 ok\\nextra\\n" > "$TASK_SYNC_STATUS_FILE"',
					'assert_unhealthy'
				].join('\n')
			);

			expect(result.status, result.stderr).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('reports the persisted reconciliation reason through the healthcheck mode', () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-task-sync-report-'));
		const statusFile = join(root, 'task-sync.status');

		try {
			const result = runSourcedScript(
				ENTRYPOINT,
				[
					`TASK_SYNC_STATUS_FILE=${JSON.stringify(statusFile)}`,
					'now="$(/usr/bin/date +%s)"',
					'printf "degraded %s skipped\\n" "$now" > "$TASK_SYNC_STATUS_FILE"',
					'set +e',
					'main --check-task-sync-health',
					'rc=$?',
					'printf "degraded %s skipped secret-canary\\n" "$now" > "$TASK_SYNC_STATUS_FILE"',
					'main --check-task-sync-health',
					'invalid_rc=$?',
					'set -e',
					'test "$rc" -eq 1',
					'test "$invalid_rc" -eq 1'
				].join('\n')
			);

			expect(result.status).toBe(0);
			expect(result.stderr).toContain('status=degraded reason=skipped');
			expect(result.stderr).toContain('fresh=true');
			expect(result.stderr).toContain('status=invalid reason=invalid');
			expect(result.stderr).not.toContain('secret-canary');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('gives descendants a bounded TERM grace before KILL cleanup', () => {
		const result = runSourcedScript(
			ENTRYPOINT,
			[
				'kill() { printf "kill"; printf " %s" "$@"; printf "\\n"; }',
				'sleep() { printf "sleep %s\\n" "$1"; }',
				'wait() { printf "wait"; printf " %s" "$@"; printf "\\n"; }',
				'terminate_runtime_processes 11 12 13'
			].join('\n')
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe('kill -TERM -1\nsleep 5\nkill -KILL -1\nwait 11 12 13\n');
	});

	test('terminates the periodic monitor after a fatal status result', () => {
		const result = runSourcedScript(
			ENTRYPOINT,
			[
				'sleep() { :; }',
				'set_task_sync_status() { :; }',
				'reconcile_akm_tasks() { return "$TASK_SYNC_MONITOR_FATAL_RC"; }',
				'set +e',
				'sync_tasks_forever /bin/true',
				'rc=$?',
				'set -e',
				'test "$rc" -eq "$TASK_SYNC_MONITOR_FATAL_RC"'
			].join('\n')
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain('health monitor failed; stopping the container');
	});
});
