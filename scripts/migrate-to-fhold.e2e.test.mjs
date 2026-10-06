// Opt-in qualification with released executables and actual native engines.
// No real account files, library installer calls or replacement databases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const oldCli = process.env.OP_MIGRATION_E2E_CLI;
const cli = process.env.FH_MIGRATION_E2E_CLI;
const image = process.env.OP_MIGRATION_E2E_IMAGE;
const enabled = process.platform === 'linux' && oldCli && cli && image;
const script = join(dirname(fileURLToPath(import.meta.url)), 'migrate-to-fhold.mjs');

function run(command, args, env = {}) {
	const result = spawnSync(command, args, {
		env: { ...process.env, ...env },
		encoding: 'utf8',
		timeout: 240_000,
		maxBuffer: 16 * 1024 * 1024
	});
	assert.equal(result.error, undefined, `${command} ${args[0]}: ${result.error?.message}`);
	assert.equal(result.status, 0, `${command} ${args[0]}: ${result.stderr}`);
	return result.stdout.trim();
}

async function availablePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

function hash(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('packaged CLI migration preserves native history, accounts, files and policies without replay', {
	skip: !enabled,
	timeout: 600_000
}, async () => {
	process.umask(0o077);
	const root = mkdtempSync(join(tmpdir(), 'openpalm-fhold-migration-e2e-'));
	const source = join(root, 'old'),
		target = join(root, 'new'),
		backup = join(root, 'backup');
	const name = `fhold-migration-e2e-${process.pid}`;
	const externalNative = join(root, 'external-native-home');
	const old = (args) => run(oldCli, args, { OP_HOME: source });
	const next = (args) => run(cli, args, { FH_HOME: target });
	const port = await availablePort();
	const gatewayPort = await availablePort();
	const write = (rel, value) => {
		mkdirSync(dirname(join(source, rel)), { recursive: true });
		writeFileSync(join(source, rel), value, { mode: 0o600 });
	};
	let sourceInstalled = false,
		targetInstalled = false;
	try {
		old(['install', '--no-start']);
		sourceInstalled = true;
		old([
			'config',
			'assistant',
			'--bind',
			'127.0.0.1',
			'--port',
			String(port),
			'--timezone',
			'UTC',
			'--no-apply'
		]);
		old(['config', 'gateway', '--port', String(gatewayPort), '--no-apply']);
		old(['credential', 'add', 'reader', 'read']);
		old(['credential', 'map', 'discord', '123456789012345678', 'owner']);
		old(['portal', 'access', 'discord', '--users', '123456789012345678', '--no-apply']);
		// The normal old entrypoint initializes its own installed native plugins.
		old(['start']);
		const sourceIds = run('docker', [
			'ps',
			'-q',
			'--filter',
			`label=com.docker.compose.project.working_dir=${source}/system/stack`
		])
			.split(/\s+/)
			.filter(Boolean);
		assert.equal(sourceIds.length, 1);
		const deadline = Date.now() + 90_000;
		while (
			run('docker', ['inspect', '--format', '{{.State.Health.Status}}', sourceIds[0]]) !== 'healthy'
		) {
			assert.ok(Date.now() < deadline, 'Old Assistant did not become healthy');
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		old(['stop']);
		old(['addon', 'enable', 'gateway', '--no-apply']);
		write(
			'knowledge/memories/migration.md',
			'# Migration qualification\nSynthetic durable knowledge.\n'
		);
		write('knowledge/secrets/auth.json', '{"test":{"type":"api","key":"synthetic-test-key"}}\n');
		write('knowledge/env/user.env', 'EXAMPLE_USER_SETTING=preserve-me\n');
		write(
			'config/assistant/opencode.json',
			JSON.stringify({
				provider: {
					test: {
						npm: '@ai-sdk/openai-compatible',
						options: { baseURL: 'https://example.invalid/v1' },
						models: { test: {} }
					}
				}
			})
		);
		write('knowledge/tasks/review.yml', 'version: 4\nname: review\n');
		write('workspace/project/work.txt', 'Synthetic authored work.\n');
		write('workspace/project/node_modules/omitted.txt', 'generated\n');
		write('data/assistant/.example-addon/config.json', '{"synthetic":true}\n');
		mkdirSync(join(source, 'workspace/empty-context'));
		const time = 1780000000000;
		const transcript = (n, directory, interrupted = false) => ({
			info: {
				id: `ses_migration${n}`,
				slug: 'migration-test',
				projectID: 'global',
				directory,
				title: `Synthetic migration ${n}`,
				version: '1.18.21',
				time: { created: time, updated: time }
			},
			messages: [
				{
					info: interrupted
						? {
								id: `msg_migration${n}`,
								sessionID: `ses_migration${n}`,
								role: 'assistant',
								time: { created: time },
								parentID: 'msg_migration1',
								providerID: 'test',
								modelID: 'test',
								agent: 'build',
								mode: 'build',
								path: { cwd: directory, root: '/work' },
								cost: 0,
								tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
							}
						: {
								id: `msg_migration${n}`,
								sessionID: `ses_migration${n}`,
								role: 'user',
								time: { created: time },
								agent: 'build',
								model: { providerID: 'test', modelID: 'test' }
							},
					parts: [
						interrupted
							? {
									id: `prt_migration${n}`,
									sessionID: `ses_migration${n}`,
									messageID: `msg_migration${n}`,
									type: 'tool',
									callID: 'call_interrupted',
									tool: 'bash',
									state: {
										status: 'running',
										input: { command: 'touch /work/MUST-NOT-EXECUTE' },
										time: { start: time }
									}
								}
							: {
									id: `prt_migration${n}`,
									sessionID: `ses_migration${n}`,
									messageID: `msg_migration${n}`,
									type: 'text',
									text: 'Authored historical text.'
								}
					]
				}
			]
		});
		for (const [n, directory, interrupted] of [
			[1, '/work/project', false],
			[2, '/work/empty-context', true]
		]) {
			const seed = join(root, `seed-${n}.json`);
			const fixture = transcript(n, directory, interrupted);
			if (n === 2) fixture.messages[0].parts.push({
				id: 'prt_migration3', sessionID: 'ses_migration2', messageID: 'msg_migration2',
				type: 'tool', callID: 'call_old_error', tool: 'bash', state: {
					status: 'error', input: { command: 'synthetic historical command' },
					error: 'Synthetic historical failure', metadata: {}, time: { start: time, end: time }
				}
			});
			writeFileSync(seed, JSON.stringify(fixture));
			run('docker', [
				'run',
				'--rm',
				'--network',
				'none',
				'--read-only',
				'--cap-drop',
				'ALL',
				'--security-opt',
				'no-new-privileges:true',
				'--user',
				`${process.getuid()}:${process.getgid()}`,
				'--tmpfs',
				'/tmp:rw,mode=1777',
				'-e',
				'HOME=/tmp/native',
				'-e',
				'XDG_DATA_HOME=/native-data',
				'-e',
				'XDG_CONFIG_HOME=/tmp/config',
				'-e',
				'OPENCODE_CONFIG_DIR=/tmp/config',
				'-e',
				'OPENCODE_CONFIG_CONTENT={}',
				'-e',
				'OPENCODE_DISABLE_PROJECT_CONFIG=true',
				'--mount',
				`type=bind,src=${source}/data/assistant/.local/share,dst=/native-data`,
				'--mount',
				`type=bind,src=${seed},dst=/seed.json,readonly`,
				'--mount',
				`type=bind,src=${source}/workspace,dst=/work`,
				'--workdir',
				directory,
				'--entrypoint',
				'opencode',
				image,
				'--pure',
				'import',
				'/seed.json'
			]);
		}
		const database = join(source, 'data/assistant/.local/share/opencode/opencode.db');
		const sourceDb = new DatabaseSync(database);
		// Fixture creation only: reproduce an old engine's empty parser artifact
		// before migration. Never repair a test result or alter production data.
		assert.equal(sourceDb.prepare("UPDATE part SET data=json_set(data, '$.state.raw', '', '$.state.title', 'Synthetic historical title') WHERE id=?")
			.run('prt_migration3').changes, 1);
		assert.deepEqual(
			sourceDb
				.prepare('SELECT id, directory FROM session ORDER BY id')
				.all()
				.map((row) => ({ ...row })),
			[
				{ id: 'ses_migration1', directory: '/work/project' },
				{ id: 'ses_migration2', directory: '/work/empty-context' }
			]
		);
		sourceDb.close();
		const before = hash(database);
		// All original public-CLI configuration is complete while the fixture is
		// ordinary lean input. Model an older installation's external cold data.
		renameSync(join(source, 'data/assistant'), externalNative);
		symlinkSync(externalNative, join(source, 'data/assistant'));
		const args = [
			script,
			'--from',
			source,
			'--to',
			target,
			'--name',
			name,
			'--fhold',
			cli,
			'--source-image',
			image,
			'--runtime',
			join(externalNative, '.local/share/opencode'),
			'--backup',
			backup,
			'--include-provider-auth',
			'--include-user-env',
			'--include-native-accounts',
			'--native-path',
			'.example-addon',
			'--archive-interrupted'
		];
		const preview = JSON.parse(run(process.execPath, args));
		assert.equal(preview.mode, 'preview');
		assert.equal(existsSync(target), false);
		assert.equal(existsSync(backup), false);
		assert.ok(preview.externalArchives.some((entry) => entry.source === externalNative));
		run(process.execPath, [...args, '--apply']);
		targetInstalled = true;
		assert.ok(existsSync(join(backup, 'external-0.tar')));
		assert.equal(JSON.parse(readFileSync(join(backup, 'external-0.json'), 'utf8')).physical, externalNative);
		assert.equal(hash(database), before);
		assert.equal(
			readFileSync(join(target, 'workspace/project/work.txt'), 'utf8'),
			'Synthetic authored work.\n'
		);
		assert.equal(existsSync(join(target, 'workspace/project/node_modules')), false);
		assert.equal(existsSync(join(target, 'knowledge/tasks/review.yml')), false);
		assert.equal(existsSync(join(target, 'knowledge/imported-tasks/review.yml')), true);
		assert.equal(
			readFileSync(join(target, 'knowledge/secrets/auth.json'), 'utf8'),
			readFileSync(join(source, 'knowledge/secrets/auth.json'), 'utf8')
		);
		assert.equal(existsSync(join(target, 'data/assistant/.example-addon/config.json')), true);
		assert.notEqual(
			hash(join(source, 'state/credentials/owner/key')),
			hash(join(target, 'state/credentials/owner/key'))
		);
		const intent = JSON.parse(next(['config', 'show']));
		assert.equal(intent.deployment.projectName, name);
		assert.equal(intent.assistant.port, port);
		assert.equal(intent.assistant.claudeRemote, false);
		assert.equal(intent.assistant.codexRemote, false);
		assert.equal(intent.credentials.reader.policy, 'read');
		assert.equal(intent.gateway.enabled, true);
		assert.match(next(['credential', 'mappings', 'discord']), /123456789012345678\towner\tfull/);
		assert.deepEqual(
			JSON.parse(readFileSync(join(target, 'config/portal/discord/credentials.json'), 'utf8'))
				.users,
			{ '123456789012345678': 'owner' }
		);
		const db = new DatabaseSync(join(target, 'data/assistant/.local/share/opencode/opencode.db'), {
			readOnly: true
		});
		assert.equal(db.prepare('SELECT count(*) AS n FROM session').get().n, 2);
		assert.equal(db.prepare('SELECT count(*) AS n FROM message').get().n, 2);
		assert.equal(db.prepare('SELECT count(*) AS n FROM part').get().n, 3);
		assert.deepEqual(
			db
				.prepare('SELECT id, directory FROM session ORDER BY id')
				.all()
				.map((row) => ({ ...row })),
			[
				{ id: 'ses_migration1', directory: '/work/project' },
				{ id: 'ses_migration2', directory: '/work/empty-context' }
			]
		);
		assert.equal(db.prepare('SELECT permission FROM session LIMIT 1').get().permission, null);
		const part = JSON.parse(
			db.prepare('SELECT data FROM part WHERE id=?').get('prt_migration2').data
		);
		assert.equal(part.state.status, 'error');
		assert.match(part.state.error, /interrupted/);
		const oldError = JSON.parse(db.prepare('SELECT data FROM part WHERE id=?').get('prt_migration3').data);
		assert.equal(oldError.state.error, 'Synthetic historical failure');
		assert.equal(oldError.state.metadata.archivedTitle, 'Synthetic historical title');
		assert.equal(Object.hasOwn(oldError.state, 'raw'), false);
		const preparation = JSON.parse(readFileSync(join(backup, 'prepared-native-history/normalization.json'), 'utf8'));
		assert.equal(preparation.normalizations.length, 2);
		assert.equal(preparation.normalizations[0].part, 'prt_migration3');
		db.close();
		assert.equal(existsSync(join(target, 'workspace/MUST-NOT-EXECUTE')), false);
		const raw = JSON.parse(
			readFileSync(join(backup, 'native-history/ses_migration2.json'), 'utf8')
		);
		assert.equal(raw.messages[0].parts[0].state.status, 'running');
		next(['start']);
		const ids = run('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${name}`])
			.split(/\s+/)
			.filter(Boolean);
		const assistant = JSON.parse(run('docker', ['inspect', ...ids])).find(
			(c) => c.Config.Labels['com.docker.compose.service'] === 'assistant'
		);
		assert.equal(assistant.Config.Hostname, name);
		assert.equal(assistant.Config.User, '1000:1000');
		// Standard vendor commands, not hand-written native registry replacements.
		run('docker', [
			'exec',
			assistant.Id,
			'claude',
			'plugin',
			'marketplace',
			'update',
			'akm-plugins'
		]);
		run('docker', [
			'exec',
			assistant.Id,
			'claude',
			'plugin',
			'update',
			'akm@akm-plugins',
			'--scope',
			'user'
		]);
		run('docker', ['exec', assistant.Id, 'codex', 'plugin', 'add', 'akm@akm-plugins']);
		const expected = JSON.parse(
			run('docker', [
				'exec',
				assistant.Id,
				'node',
				'-p',
				'JSON.stringify(require("/opt/fhold/tools/package.json").dependencies)'
			])
		)['akm-opencode'];
		const claude = JSON.parse(
			run('docker', ['exec', assistant.Id, 'claude', 'plugin', 'list', '--json'])
		);
		assert.ok(
			claude.some((p) => p.id === 'akm@akm-plugins' && p.enabled && p.version === expected)
		);
		const codex = JSON.parse(
			run('docker', ['exec', assistant.Id, 'codex', 'plugin', 'list', '--json'])
		);
		assert.ok(
			codex.installed.some(
				(p) => p.pluginId === 'akm@akm-plugins' && p.enabled && p.version === expected
			)
		);
		const password = readFileSync(
			join(target, 'state/secrets/fhold_opencode_password'),
			'utf8'
		).trim();
		const headers = {
			Authorization: `Basic ${Buffer.from(`user:${password}`).toString('base64')}`
		};
		const apiDeadline = Date.now() + 90_000;
		let sessions;
		while (Date.now() < apiDeadline) {
			try {
				const response = await fetch(
					`http://127.0.0.1:${port}/session?directory=${encodeURIComponent('/work/project')}`,
					{ headers }
				);
				if (response.ok) {
					sessions = await response.json();
					break;
				}
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		assert.ok(
			sessions?.some((session) => session.id === 'ses_migration1'),
			'Native API did not expose migrated project history'
		);
		next(['restart']);
		assert.equal(existsSync(join(target, 'workspace/MUST-NOT-EXECUTE')), false);
		const resumed = await fetch(
			`http://127.0.0.1:${port}/session?directory=${encodeURIComponent('/work/project')}`,
			{ headers }
		);
		assert.equal(resumed.status, 200);
		assert.ok((await resumed.json()).some((session) => session.id === 'ses_migration1'));
		assert.equal((await fetch(`http://127.0.0.1:${port}/session`)).status, 401);
		assert.equal((await fetch(`http://127.0.0.1:${gatewayPort}/health`)).status, 200);
		assert.equal(
			(await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, { method: 'POST' })).status,
			401
		);
		const restartedIds = run('docker', [
			'ps',
			'-q',
			'--filter',
			`label=com.docker.compose.project=${name}`,
			'--filter',
			'label=com.docker.compose.service=assistant'
		]).trim();
		const refreshed = JSON.parse(
			run('docker', ['exec', restartedIds, 'codex', 'plugin', 'list', '--json'])
		);
		assert.ok(
			refreshed.installed.some(
				(plugin) =>
					plugin.pluginId === 'akm@akm-plugins' && plugin.version === expected && plugin.enabled
			)
		);
		assert.match(
			run('docker', ['exec', restartedIds, 'fhold-remote', 'claude', 'status']),
			/not-started/
		);
		assert.match(
			run('docker', ['exec', restartedIds, 'fhold-remote', 'codex', 'status']),
			/not-started/
		);
		console.log(`Packaged CLI migration qualified: ${root}`);
	} finally {
		if (targetInstalled) next(['stop']);
		if (existsSync(externalNative)) {
			unlinkSync(join(source, 'data/assistant'));
			renameSync(externalNative, join(source, 'data/assistant'));
		}
		if (sourceInstalled) old(['stop']);
		console.log(`Migration fixtures retained at ${root}`);
	}
});
