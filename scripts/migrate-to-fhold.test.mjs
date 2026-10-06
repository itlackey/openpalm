import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
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
		const rawArgs = args;
		const selectedHome = args[0] === '--name' ? args[1] : env?.FH_HOME;
		if (args[0] === '--name') args = args.slice(2);
		calls.push({ command, args, env, rawArgs, selectedHome });
		if (command === cli && args[0] === '--version') return '0.1.2610040208-alpha.2';
		if (command === cli && args[0] === 'help') return 'history restore --archive-interrupted';
		if (command === 'docker' && args[0] === 'image') return `sha256:${'a'.repeat(64)}`;
		if (command === 'docker' && args[0] === 'ps') return '';
		if (command === cli && args[0] === 'install') {
			mkdirSync(selectedHome, { recursive: true });
			mkdirSync(join(selectedHome, 'state'));
			writeFileSync(
				join(selectedHome, 'state/stack.json'),
				readFileSync(args[args.indexOf('--config') + 1])
			);
		}
		if (command === cli && args[0] === 'history' && args[1] === 'export') {
			const dest = args[args.indexOf('--to') + 1];
			mkdirSync(dest);
			const native = JSON.stringify({ info: { id: 'ses_fixture', directory: '/work/empty-project' },
				messages: [{ info: { id: 'msg_fixture', sessionID: 'ses_fixture' },
					parts: [{ id: 'prt_fixture', type: 'text', text: 'synthetic' }] }] });
			writeFileSync(join(dest, 'ses_fixture.json'), native);
			writeFileSync(
				join(dest, 'history.json'),
				JSON.stringify({
					product: 'fhold',
					scope: 'native-history',
					version: 1,
					sessions: [{ id: 'ses_fixture', directory: '/work/empty-project', messages: 1, parts: 1,
						sha256: createHash('sha256').update(native).digest('hex') }]
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

test('large authored regular files are hashed in the ordinary preview instead of excluded', () => {
	const f = fixture();
	const rel = 'workspace/project/authored-large.pack';
	f.write(rel, '');
	const fd = openSync(join(f.source, rel), 'r+');
	try { ftruncateSync(fd, 257 * 1024 * 1024); }
	finally { closeSync(fd); }
	const plan = planMigration(f.options, f.run);
	const entry = plan.files.find((file) => file.to === rel);
	assert.equal(entry.bytes, 257 * 1024 * 1024);
	assert.match(entry.sha256, /^[a-f0-9]{64}$/);
	assert.equal(existsSync(plan.target), false);
	assert.equal(existsSync(plan.backup), false);
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
	assert.throws(() => planMigration(h.options, h.run), /OpenPalm home with validated lean intent/);
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
				c.rawArgs[0] === '--name' && c.selectedHome === plan.target &&
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

test('legacy 0.13 needs reviewed intent/runtime and linked native state stays out of target authority', () => {
	const f = fixture();
	const reviewed = join(f.root, 'reviewed-source-config.json');
	renameSync(join(f.source, 'state/stack.json'), reviewed);
	renameSync(join(f.source, 'system/stack/stack.compose.yml'), join(f.source, 'system/stack/core.compose.yml'));
	const native = join(f.root, 'external-native-home');
	renameSync(join(f.source, 'data/assistant'), native);
	symlinkSync(native, join(f.source, 'data/assistant'));
	assert.throws(() => planMigration(f.options, f.run), /explicit reviewed/);
	const options = {...f.options, 'source-config': reviewed,
		runtime: join(native, '.local/share/opencode'), 'include-native-accounts': true};
	assert.throws(() => planMigration(options, f.run), /stopped, not removed/);
	const run = (command, args, env) => {
		if (command === 'docker' && args[0] === 'ps')
			return args.some(arg => arg.startsWith('label=com.docker.compose.project=')) ? '' : 'legacy-assistant';
		if (command === 'docker' && args[0] === 'inspect') return JSON.stringify([{
			Id: 'legacy-assistant', Name: '/old-assistant', State: {Running: false}, Image: `sha256:${'a'.repeat(64)}`,
			Config: {Labels: {'com.docker.compose.project.working_dir': join(f.source, 'system/stack')}},
			Mounts: [{Type: 'bind', Source: native, Destination: '/home/opencode'}]
		}]);
		return f.run(command, args, env);
	};
	const plan = planMigration(options, run);
	assert.equal(plan.legacy, true);
	assert.equal(plan.config.deployment.imageNamespace, 'fwdslsh');
	assert.match(plan.targetImage, /^fwdslsh\/fhold-assistant:/);
	assert.equal(plan.containers.length, 1);
	assert.deepEqual(plan.externalMounts.map((mount) => mount.physical), [native]);
	assert.ok(plan.files.some((file) => file.root === native && file.to === 'data/assistant/.claude.json'));
	assert.throws(() => planMigration({...options, runtime: f.root}, run), /selected source Assistant/);
});

test('lean source shutdown may remove containers but resolved native data still gets its own archive', () => {
	const f = fixture();
	const native = join(f.root, 'external-native-home');
	renameSync(join(f.source, 'data/assistant'), native);
	symlinkSync(native, join(f.source, 'data/assistant'));
	const plan = planMigration({...f.options, runtime: join(native, '.local/share/opencode')}, f.run);
	assert.equal(plan.containers.length, 0);
	assert.deepEqual(plan.externalMounts.map((mount) => mount.physical), [native]);
});

test('disabled configured portal retains private token setup without enabling the bot', () => {
	const f = fixture();
	f.write('state/secrets/slack_bot_token', 'synthetic-bot-token');
	f.write('state/secrets/slack_app_token', 'synthetic-app-token');
	const plan = planMigration(f.options, f.run);
	applyMigration(plan, f.run);
	const calls = f.calls.filter((c) => c.command === f.options.fhold);
	assert.ok(calls.some((c) => c.args[0] === 'portal' && c.args[1] === 'token' && c.args[2] === 'slack'
		&& c.args.includes('--bot-token-file') && c.args.includes('--app-token-file') && c.args.includes('--no-apply')));
	assert.ok(!calls.some((c) => c.args.join(' ').startsWith('portal enable slack')));
});

test('disabled blank portal placeholders are not configured credentials', () => {
	const f = fixture();
	f.write('state/secrets/discord_bot_token', '\n');
	f.write('state/secrets/slack_bot_token', ' \n');
	f.write('state/secrets/slack_app_token', '\t\n');
	const plan = planMigration(f.options, f.run);
	applyMigration(plan, f.run);
	const calls = f.calls.filter((c) => c.command === f.options.fhold);
	assert.ok(!calls.some((c) => c.args[0] === 'portal' && c.args[1] === 'token'));
	assert.ok(!calls.some((c) => c.args[0] === 'portal' && c.args[1] === 'enable'));
});

test('directory map is explicit and refuses path escapes before writing', () => {
	const f = fixture();
	const map = join(f.root, 'directories.json');
	writeFileSync(map, JSON.stringify({'/stash': '/work'}));
	assert.deepEqual(planMigration({...f.options, 'directory-map': map}, f.run).suppliedDirectories, {'/stash': '/work'});
	writeFileSync(map, JSON.stringify({'/stash': '/work/../secret'}));
	assert.throws(() => planMigration({...f.options, 'directory-map': map}, f.run), /Unsafe history directory map/);
});

test('inventories named volumes without traversing Docker private paths and resolves explicit external bind sources', () => {
	const f = fixture();
	const outside = join(f.root, 'external');
	mkdirSync(outside);
	const run = (command, args, env) => {
		if (command === 'docker' && args[0] === 'ps')
			return args.some(arg => arg.startsWith('label=com.docker.compose.project=')) ? '' : 'source-id';
		if (command === 'docker' && args[0] === 'inspect') return JSON.stringify([{
			Id:'source-id', Name:'/old-assistant', State:{Running:false}, Image:`sha256:${'a'.repeat(64)}`,
			Config:{Labels:{'com.docker.compose.project.working_dir':join(f.source, 'system/stack')}},
			Mounts:[{Type:'bind',Source:join(f.source,'data/assistant'),Destination:'/home/opencode'},
				{Type:'bind',Source:outside,Destination:'/external'},
				{Type:'volume',Source:'/not-readable/docker/data',Name:'old-persistent',Destination:'/opt/persistent'}]
		}]);
		return f.run(command,args,env);
	};
	const plan = planMigration(f.options, run);
	assert.equal(plan.externalMounts.length, 2);
	assert.equal(plan.externalMounts[0].physical, outside);
	assert.equal(plan.externalMounts[1].name, 'old-persistent');
});

test('detects changed source after preview and keeps original/private evidence instead of overwriting blindly', () => {
	const f = fixture();
	const plan = planMigration(f.options, f.run);
	f.write('workspace/project/file.txt', 'new work');
	assert.throws(() => applyMigration(plan, f.run), /Source changed/);
	assert.equal(existsSync(join(plan.backup, 'migration-plan.json')), true);
	assert.equal(existsSync(join(plan.backup, 'migration-complete.json')), false);
});

test('preview refuses a name owned by a retained stopped project before creating anything', () => {
	const f = fixture();
	const run = (command, args, env) => {
		if (command === 'docker' && args[0] === 'ps' && args.includes('label=com.docker.compose.project=april')) return 'older-stopped-container';
		return f.run(command, args, env);
	};
	assert.throws(() => planMigration(f.options, run), /running or stopped stack/);
	assert.equal(existsSync(f.options.to), false);
	assert.equal(existsSync(f.options.backup), false);
});

test('apply rechecks a project name claimed after preview without copying or changing either home', () => {
	const f = fixture(); const plan = planMigration(f.options, f.run);
	const run = (command, args, env) => {
		if (command === 'docker' && args[0] === 'ps' && args.includes('label=com.docker.compose.project=april')) return 'new-owner';
		return f.run(command, args, env);
	};
	assert.throws(() => applyMigration(plan, run), /unique new name/);
	assert.equal(existsSync(plan.target), false);
	assert.equal(existsSync(plan.backup), false);
	assert.equal(readFileSync(join(f.source, 'workspace/project/file.txt'), 'utf8'), 'authored work');
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
