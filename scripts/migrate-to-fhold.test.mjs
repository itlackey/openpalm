import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigration, planMigration } from './migrate-to-fhold.mjs';

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-fhold-migration-unit-'));
	const source = join(root, 'source');
	const write = (rel, content) => {
		mkdirSync(join(source, rel, '..'), { recursive: true });
		writeFileSync(join(source, rel), content);
	};
	const config = {
		version: 1,
		assistant: {
			bindAddress: '127.0.0.1',
			port: 3810,
			timezone: 'UTC',
			automaticMemory: true,
			codexRemote: false,
			claudeRemote: true,
			codexSandbox: 'workspace-write'
		},
		gateway: { enabled: true, bindAddress: '127.0.0.1', port: 3830 },
		credentials: {
			owner: { id: 'owner', policy: 'full' },
			discord: { id: 'discord', policy: 'chat' },
			helper: { id: 'old-id-not-imported', policy: 'read' }
		},
		portals: {
			discord: {
				enabled: false,
				credential: 'discord',
				access: { guilds: [], roles: [], users: ['123456789'], blockedUsers: [] }
			},
			slack: {
				enabled: false,
				credential: 'owner',
				access: { channels: [], users: [], blockedUsers: [] }
			}
		}
	};
	write('state/stack.json', JSON.stringify(config));
	write('system/stack/stack.compose.yml', 'services: {}\n');
	write('knowledge/memories/fact.md', 'authored fact');
	write('knowledge/secrets/auth.json', '{"test":{"key":"synthetic-secret"}}');
	write('knowledge/env/user.env', 'TEST_KEY=synthetic');
	write('knowledge/env/old-managed.env', 'DO_NOT_IMPORT=1');
	write('knowledge/tasks/news.yml', 'version: 4');
	write(
		'config/portal/discord/credentials.json',
		JSON.stringify({ version: 1, users: { 123456789: 'owner' } })
	);
	write('workspace/project/file.txt', 'authored work');
	write('workspace/project/node_modules/generated.txt', 'generated');
	mkdirSync(join(source, 'workspace/empty-project'), { recursive: true });
	write('data/assistant/.claude.json', '{"synthetic":true}');
	write('data/assistant/.codex/state_5.sqlite', 'cold fixture');
	write('data/assistant/.codex/state_5.sqlite-wal', 'cold WAL fixture');
	write('data/assistant/.codex/state_5.sqlite-shm', 'volatile');
	write('data/assistant/.codex/worker.pid', '123');
	write('data/assistant/.local/share/opencode/opencode.db', 'must use native transfer');
	const cli = join(root, 'fhold-cli');
	writeFileSync(cli, 'synthetic executable');
	chmodSync(cli, 0o700);
	const calls = [];
	const run = (command, args, env) => {
		calls.push({ command, args, env });
		if (command === cli && args[0] === '--version') return '0.1.2610040208-alpha.2';
		if (command === cli && args[0] === 'help') return 'history restore --archive-interrupted';
		if (command === 'docker' && args[0] === 'image') return `sha256:${'a'.repeat(64)}`;
		if (command === 'docker' && args[0] === 'ps') return '';
		if (command === cli && args[0] === 'install') {
			mkdirSync(env.FH_HOME, { recursive: true });
			mkdirSync(join(env.FH_HOME, 'state'));
			writeFileSync(
				join(env.FH_HOME, 'state/stack.json'),
				readFileSync(args[args.indexOf('--config') + 1])
			);
		}
		if (command === cli && args[0] === 'history' && args[1] === 'export') {
			const dest = args[args.indexOf('--to') + 1];
			mkdirSync(dest);
			writeFileSync(
				join(dest, 'history.json'),
				JSON.stringify({
					product: 'fhold',
					scope: 'native-history',
					version: 1,
					sessions: [{ id: 'ses_fixture', directory: '/work/empty-project', messages: 1, parts: 1 }]
				})
			);
		}
		return '';
	};
	return {
		root,
		source,
		write,
		config,
		run,
		calls,
		options: {
			from: source,
			to: join(root, 'destination'),
			name: 'april',
			fhold: cli,
			'source-image': 'openpalm/assistant:test',
			backup: join(root, 'private-backup')
		}
	};
}

test('preview is read-only; copies authored files, stages tasks, preserves empty contexts and owner mapping', () => {
	const f = fixture();
	const plan = planMigration(f.options, f.run);
	assert.equal(existsSync(plan.target), false);
	assert.equal(existsSync(plan.backup), false);
	assert.equal(plan.maps.discord.users['123456789'], 'owner');
	assert.equal(plan.config.assistant.claudeRemote, false);
	assert.equal(plan.sourceConfig.assistant.claudeRemote, true);
	assert.equal(plan.config.deployment.projectName, 'april');
	assert.ok(plan.directories.includes('workspace/empty-project'));
	assert.ok(plan.files.some((f) => f.to === 'knowledge/imported-tasks/news.yml'));
	assert.ok(plan.files.some((f) => f.to === 'workspace/project/file.txt'));
	assert.ok(!plan.files.some((f) => /node_modules|secrets|env|opencode.db|\.codex/.test(f.to)));
	assert.ok(!f.calls.some((c) => c.args.includes('install') || c.args.includes('stop')));
});

test('explicit opt-ins preserve native cold SQLite WAL, omit coordination and never copy OpenCode DB', () => {
	const f = fixture();
	const plan = planMigration(
		{
			...f.options,
			'include-provider-auth': true,
			'include-user-env': true,
			'include-native-accounts': true
		},
		f.run
	);
	assert.ok(plan.files.some((f) => f.to.endsWith('auth.json')));
	assert.ok(plan.files.some((f) => f.to.endsWith('user.env')));
	assert.ok(plan.files.some((f) => f.to.endsWith('state_5.sqlite-wal')));
	assert.ok(!plan.files.some((f) => /-shm$|worker.pid$|opencode.db$|old-managed.env$/.test(f.to)));
});

test('preserves the standard native OpenAI-compatible SDK but refuses arbitrary package overrides', () => {
	const f = fixture();
	f.write(
		'config/assistant/opencode.json',
		JSON.stringify({
			provider: {
				local: {
					npm: '@ai-sdk/openai-compatible',
					options: { baseURL: 'http://127.0.0.1:8080/v1' }
				}
			}
		})
	);
	assert.ok(
		planMigration(f.options, f.run).files.some(
			(entry) => entry.to === 'config/assistant/opencode.json'
		)
	);
	f.write(
		'config/assistant/opencode.json',
		JSON.stringify({ provider: { custom: { npm: 'file:/unreviewed-plugin' } } })
	);
	assert.throws(() => planMigration(f.options, f.run), /nonstandard provider SDK/);
});

test('refuses occupied/nested homes, linked user files, unknown credentials and foreign source', () => {
	const f = fixture();
	assert.throws(() => planMigration({ ...f.options, to: f.source }, f.run), /nonexistent/);
	assert.throws(
		() => planMigration({ ...f.options, backup: join(f.source, 'backup') }, f.run),
		/separate/
	);
	symlinkSync('/etc/passwd', join(f.source, 'workspace/escape'));
	assert.throws(() => planMigration(f.options, f.run), /linked data/);
	const g = fixture();
	g.write(
		'config/portal/discord/credentials.json',
		JSON.stringify({ version: 1, users: { 123456789: 'missing' } })
	);
	assert.throws(() => planMigration(g.options, g.run), /Unknown mapped/);
	const h = fixture();
	h.write('state/stack.json', JSON.stringify({ ...h.config, product: 'fhold' }));
	assert.throws(() => planMigration(h.options, h.run), /lean OpenPalm/);
});

test('apply is ordinary packaged CLI install/history/configuration, fresh keys, no automatic start or direct state writes', () => {
	const f = fixture();
	const plan = planMigration({ ...f.options, 'archive-interrupted': true }, f.run);
	applyMigration(plan, f.run);
	const calls = f.calls.filter((c) => c.command === f.options.fhold);
	assert.ok(
		calls.some(
			(c) =>
				c.args[0] === 'install' &&
				c.args.includes('--name') &&
				c.args.includes('--config') &&
				c.args.includes('--no-start')
		)
	);
	assert.ok(calls.some((c) => c.args.join(' ') === 'credential add helper read'));
	assert.ok(calls.some((c) => c.args.join(' ') === 'credential map discord 123456789 owner'));
	assert.equal(calls.filter((c) => c.args[0] === 'history' && c.args[1] === 'restore').length, 2);
	assert.ok(
		calls.some(
			(c) => c.args.includes('--archive-interrupted') && c.args.includes('--same-instance')
		)
	);
	assert.ok(
		!calls.some(
			(c) =>
				['setup', 'start', 'restart', 'remote'].includes(c.args[0]) || c.args.includes('--key-file')
		)
	);
	assert.ok(existsSync(join(plan.target, 'workspace/empty-project')));
	assert.equal(
		readFileSync(join(plan.target, 'workspace/project/file.txt'), 'utf8'),
		'authored work'
	);
	assert.equal(
		JSON.parse(readFileSync(join(plan.target, 'state/stack.json'), 'utf8')).product,
		'fhold'
	);
	assert.equal(readFileSync(join(f.source, 'workspace/project/file.txt'), 'utf8'), 'authored work');
});

test('detects changed source after preview and keeps original/private evidence instead of overwriting blindly', () => {
	const f = fixture();
	const plan = planMigration(f.options, f.run);
	f.write('workspace/project/file.txt', 'new work');
	assert.throws(() => applyMigration(plan, f.run), /Source changed/);
	assert.equal(existsSync(join(plan.backup, 'migration-plan.json')), true);
	assert.equal(existsSync(join(plan.backup, 'migration-complete.json')), false);
});

test('refuses applying against a running source before creating any backup or destination', () => {
	const f = fixture();
	const plan = planMigration(f.options, f.run);
	const run = (command, args, env) => {
		if (command === 'docker' && args[0] === 'ps') return 'container-id';
		if (command === 'docker' && args[0] === 'inspect')
			return JSON.stringify([
				{
					Id: 'container-id',
					Name: '/old-assistant',
					State: { Running: true },
					Image: `sha256:${'a'.repeat(64)}`,
					Mounts: [],
					Config: {
						Labels: { 'com.docker.compose.project.working_dir': join(f.source, 'system/stack') }
					}
				}
			]);
		return f.run(command, args, env);
	};
	assert.throws(() => applyMigration(plan, run), /Stop the source/);
	assert.equal(existsSync(plan.target), false);
	assert.equal(existsSync(plan.backup), false);
});
