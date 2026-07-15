import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const ENTRYPOINT_PATH = join(REPO_ROOT, 'containers/assistant/entrypoint.sh');
const entrypoint = readFileSync(ENTRYPOINT_PATH, 'utf8');
const dockerfile = readFileSync(join(REPO_ROOT, 'containers/assistant/Dockerfile'), 'utf8');

const INSTALL_DRIVER = `#!/usr/bin/env bash
set -uo pipefail
ENTRYPOINT="$1"
WORK="$2"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/npm" <<'STUB'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >> "$NPM_LOG"
exit 0
STUB
cat > "$WORK/bin/bun" <<'STUB'
#!/usr/bin/env bash
printf 'bun %s\n' "$*" >> "$NPM_LOG"
exit 0
STUB
cat > "$WORK/bin/node" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$WORK/bin/npm" "$WORK/bin/bun" "$WORK/bin/node"
export PATH="$WORK/bin:$PATH"
awk '!/^[a-z_][a-z0-9_]*$/ || /^(fi|done|esac|then|else|do)$/' "$ENTRYPOINT" > "$WORK/functions.sh"
sed -i "s#/opt/openpalm#$WORK/artifacts#g" "$WORK/functions.sh"
source "$WORK/functions.sh"
install_runtime_artifacts
`;

function runInstallScenario(env: Record<string, string>) {
	const work = mkdtempSync(join(tmpdir(), 'openpalm-assistant-artifacts-'));
	try {
		const driver = join(work, 'driver.sh');
		const npmLog = join(work, 'npm.log');
		writeFileSync(driver, INSTALL_DRIVER, { mode: 0o755 });
		writeFileSync(npmLog, '');
		mkdirSync(join(work, 'home'), { recursive: true });
		const result = spawnSync('bash', [driver, ENTRYPOINT_PATH, work], {
			encoding: 'utf8',
			env: {
				PATH: process.env.PATH ?? '/usr/bin:/bin',
				HOME: join(work, 'home'),
				NPM_LOG: npmLog,
				...env
			}
		});
		return {
			exitCode: result.status ?? 1,
			stderr: result.stderr ?? '',
			npmLog: readFileSync(npmLog, 'utf8')
		};
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

describe('assistant runtime artifacts after container-client removal', () => {
	test('entrypoint and image no longer install or start @openpalm/client', () => {
		expect(entrypoint).not.toContain('@openpalm/client');
		expect(entrypoint).not.toContain('start_client');
		expect(entrypoint).not.toContain('/opt/openpalm/client');
		expect(dockerfile).not.toContain('@openpalm/client');
		expect(dockerfile).not.toContain('/opt/openpalm/client');
	});

	test('image exposes and probes only OpenCode', () => {
		expect(dockerfile).toContain('EXPOSE 4096');
		expect(dockerfile).not.toMatch(/EXPOSE[^\n]*\b3000\b/);
		expect(dockerfile).toContain('http://localhost:${OPENCODE_PORT:-4096}/health');
		expect(dockerfile).not.toContain('openpalm-client-skip');
	});

	test('skeleton exact-pin installation remains intact', () => {
		const result = runInstallScenario({
			OP_SKELETON_VERSION: '2.2.2-test',
			PLATFORM_VERSION: '1.1.1-platform'
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.npmLog).toContain('@openpalm/skeleton@2.2.2-test');
		expect(result.npmLog).not.toContain('@openpalm/client');
	});

	test('skeleton still falls back to PLATFORM_VERSION', () => {
		const result = runInstallScenario({ PLATFORM_VERSION: '1.1.1-platform' });
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.npmLog).toContain('@openpalm/skeleton@1.1.1-platform');
	});

	test('scheduler, tool update, and host-served client CORS remain wired', () => {
		expect(entrypoint).toContain('start_cron_and_sync_tasks');
		expect(entrypoint).toContain('bun update --cwd "${tools_dir}" --production');
		expect(entrypoint).toContain('OP_HOST_CLIENT_PORT:-3890');
		expect(entrypoint).toContain('http://127.0.0.1:${host_client_port}');
		expect(entrypoint).not.toContain('OP_CLIENT_PORT');
		expect(entrypoint).not.toContain('OP_CLIENT_CORS_ALLOWED_ORIGINS');
	});

	test('entrypoint stays bash -n clean', () => {
		const result = spawnSync('bash', ['-n', ENTRYPOINT_PATH], { encoding: 'utf8' });
		expect(result.status, result.stderr).toBe(0);
	});
});
