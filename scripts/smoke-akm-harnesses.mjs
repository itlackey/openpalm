#!/usr/bin/env bun
// Run inside the built Assistant image, without vendor credentials or a model.
// These are real harnesses and the real AKM CLI, not a replacement plugin loader.
import assert from 'node:assert/strict';
import {
	closeSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	withCodexRecall,
	reviewRecall,
	changeRecall
} from '/usr/local/bin/openpalm-codex-recall.mjs';

const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-harnesses-'));
const prompt = 'Find the lean release verification knowledge for the personal agent rollout';
const expectedRef = 'knowledge/lean-release-verification';
const tools = JSON.parse(readFileSync('/opt/openpalm/tools/package.json', 'utf8')).dependencies;

function fixture(harness) {
	const dir = join(root, harness);
	for (const name of ['home', 'project', 'bundle/knowledge', 'config', 'state', 'cache', 'data'])
		mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(
		join(dir, 'bundle/knowledge/lean-release-verification.md'),
		'---\nname: lean-release-verification\ndescription: Lean release verification knowledge for the personal agent rollout\n---\n\n# Lean release verification\n\nVerify the personal agent rollout using all three native harnesses.\n'
	);
	const env = {
		PATH: process.env.PATH,
		HOME: join(dir, 'home'),
		XDG_CONFIG_HOME: join(dir, 'config'),
		XDG_STATE_HOME: join(dir, 'state'),
		XDG_CACHE_HOME: join(dir, 'cache'),
		XDG_DATA_HOME: join(dir, 'data'),
		AKM_BUNDLE_DIR: join(dir, 'bundle'),
		AKM_CONFIG_DIR: join(dir, 'config/akm'),
		AKM_STATE_DIR: join(dir, 'state/akm'),
		AKM_DATA_DIR: join(dir, 'data/akm'),
		AKM_CACHE_DIR: join(dir, 'cache/akm'),
		AKM_AUTO_MEMORY: '0',
		AKM_AUTO_LEARNING: '0',
		AKM_CURATE_MIN_SCORE: '0',
		BUN_OPTIONS: '--no-env-file',
		DISABLE_AUTOUPDATER: '1',
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		OPENPALM_AUTOMATIC_MEMORY: '0',
		// NSS maps explicit host UIDs in Compose, but carries no credentials.
		...(process.env.LD_PRELOAD
			? {
					LD_PRELOAD: process.env.LD_PRELOAD,
					NSS_WRAPPER_PASSWD: process.env.NSS_WRAPPER_PASSWD,
					NSS_WRAPPER_GROUP: process.env.NSS_WRAPPER_GROUP
				}
			: {})
	};
	const run = (argv) => {
		const result = Bun.spawnSync(argv, {
			cwd: join(dir, 'project'),
			env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 60_000
		});
		assert.equal(result.exitCode, 0, `${argv[0]} ${argv[1]}: ${result.stderr}`);
		return result.stdout.toString();
	};
	assert.match(run(['akm', '--version']), new RegExp(tools['akm-cli'].replaceAll('.', '\\.')));
	run(['akm', 'index']);
	assert.ok(
		run(['akm', 'curate', prompt, '--format', 'json', '-q']).includes(expectedRef),
		`${harness}: real AKM must find the fixture before exercising hooks`
	);
	return { dir, env, run, cwd: join(dir, 'project') };
}

async function waitFor(probe, label, diagnostics = []) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const result = probe();
			if (result) return result;
		} catch {
			/* file not ready */
		}
		await Bun.sleep(100);
	}
	const detail = diagnostics
		.filter(existsSync)
		.map((file) => `${file}:\n${readFileSync(file, 'utf8').slice(-8_192)}`)
		.join('\n');
	throw new Error(`Timed out: ${label}; fixtures retained at ${root}\n${detail}`);
}

function launch(f, argv) {
	const log = join(f.dir, 'harness.log');
	const output = openSync(log, 'w', 0o600);
	const proc = Bun.spawn(argv, { cwd: f.cwd, env: f.env, stdout: output, stderr: output });
	return { proc, log, close: () => closeSync(output) };
}

function events(file) {
	return readFileSync(file, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function recalled(file, harness) {
	const entries = events(file);
	const recall = entries.find(
		(e) =>
			e.event === 'prompt_recall' &&
			e.outcome.status === 'ok' &&
			e.refs?.some((ref) => (typeof ref === 'string' ? ref : ref.ref)?.includes(expectedRef))
	);
	if (!recall) return false;
	assert.ok(
		entries.some((e) => e.event === 'session_started'),
		`${harness}: session hook missing`
	);
	assert.ok(
		entries.every((e) => e.harness === harness),
		`${harness}: incorrect event ownership`
	);
	console.log(`${harness}: native session and prompt hooks recalled ${expectedRef}`);
	return true;
}

// Exercise the managed OpenCode wrapper through the native CLI, not direct hooks.
{
	const f = fixture('opencode');
	const config = join(f.dir, 'opencode');
	cpSync('/etc/opencode', config, { recursive: true });
	f.env.OPENCODE_CONFIG_DIR = config;
	f.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
	f.env.OPENCODE_DISABLE_CLAUDE_CODE = 'true';
	f.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = 'true';
	f.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
		provider: {
			openai: {
				options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'offline-fixture' }
			}
		}
	});
	const { proc, log, close } = launch(f, [
		'opencode',
		'run',
		'--model',
		'openai/gpt-5-nano',
		'--agent',
		'build',
		'--format',
		'json',
		prompt
	]);
	try {
		await waitFor(
			() => recalled(join(f.dir, 'state/akm-opencode/events.jsonl'), 'opencode'),
			'OpenCode recall',
			[log, join(f.dir, 'state/akm-opencode/events.jsonl')]
		);
	} finally {
		proc.kill();
		await proc.exited;
		close();
	}
}

// Use the build-installed native Claude registry; no --plugin-dir/inline loader.
{
	const f = fixture('claude');
	f.env.CLAUDE_CONFIG_DIR = join(f.dir, 'claude');
	mkdirSync(f.env.CLAUDE_CONFIG_DIR, { recursive: true });
	cpSync('/native-defaults/claude/settings.json', join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'));
	cpSync('/native-defaults/claude/plugins', join(f.env.CLAUDE_CONFIG_DIR, 'plugins'), {
		recursive: true
	});
	const plugins = JSON.parse(f.run(['claude', 'plugin', 'list', '--json']));
	assert.ok(
		plugins.some(
			(p) => p.id === 'akm@akm-plugins' && p.enabled && p.version === tools['akm-opencode']
		)
	);
	const debug = join(f.dir, 'debug.log');
	const { proc, log, close } = launch(f, ['claude', '-p', prompt, '--debug-file', debug]);
	try {
		await waitFor(
			() => recalled(join(f.dir, 'state/akm-claude/events.jsonl'), 'claude-code'),
			'Claude recall',
			[log, join(f.dir, 'state/akm-claude/events.jsonl')]
		);
		assert.match(readFileSync(debug, 'utf8'), /Hook SessionStart:startup \(SessionStart\) success/);
	} finally {
		proc.kill();
		await proc.exited;
		close();
	}
}

{
	const f = fixture('codex');
	f.env.CODEX_HOME = join(f.dir, 'codex');
	mkdirSync(f.env.CODEX_HOME, { recursive: true });
	cpSync('/native-defaults/codex/config.toml', join(f.env.CODEX_HOME, 'config.toml'));
	cpSync('/native-defaults/codex/plugins/cache', join(f.env.CODEX_HOME, 'plugins/cache'), {
		recursive: true
	});
	const plugins = JSON.parse(f.run(['codex', 'plugin', 'list', '--json']));
	assert.ok(
		plugins.installed.some(
			(p) => p.pluginId === 'akm@akm-plugins' && p.enabled && p.version === tools['akm-opencode']
		)
	);
	const options = { env: f.env, workdir: f.cwd };
	writeFileSync(
		join(f.env.CODEX_HOME, 'hooks.json'),
		JSON.stringify({
			hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/usr/bin/true' }] }] }
		})
	);
	const review = await withCodexRecall(reviewRecall, options);
	assert.equal(review.status, 'approval-needed');
	assert.deepEqual(review.hooks.map((h) => h.event).sort(), ['sessionStart', 'userPromptSubmit']);
	assert.ok(
		review.hooks.every((h) => h.trust === 'untrusted'),
		'Production defaults must not pre-trust hooks'
	);
	// Use the same native writer as guided setup, only in this disposable home.
	const config = join(f.env.CODEX_HOME, 'config.toml');
	writeFileSync(
		config,
		'model="offline"\nmodel_provider="offline"\n' +
			readFileSync(config, 'utf8') +
			'\n[model_providers.offline]\nname="offline"\nbase_url="http://127.0.0.1:9/v1"\n' +
			'wire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n'
	);
	assert.equal(
		(await withCodexRecall((rpc) => changeRecall(rpc, 'approve', review.digest), options)).status,
		'ready'
	);
	assert.equal(
		(await withCodexRecall(reviewRecall, options)).status,
		'ready',
		'Approval must survive a fresh native process'
	);
	const inventory = await withCodexRecall((rpc) => rpc('hooks/list', { cwds: ['/work'] }), options);
	assert.ok(
		inventory.data[0].hooks
			.filter((h) => h.source === 'user')
			.every((h) => h.trustStatus === 'untrusted'),
		'Approval must not trust unrelated native hooks'
	);
	const { proc, log, close } = launch(f, [
		'codex',
		'exec',
		'--skip-git-repo-check',
		'--json',
		'--sandbox',
		'workspace-write',
		prompt
	]);
	try {
		await waitFor(
			() => recalled(join(f.env.CODEX_HOME, 'plugins/data/akm-akm-plugins/events.jsonl'), 'codex'),
			'Codex recall',
			[log, join(f.env.CODEX_HOME, 'plugins/data/akm-akm-plugins/events.jsonl')]
		);
	} finally {
		proc.kill();
		await proc.exited;
		close();
	}
	const definition = review.hooks[0].sourcePath;
	const manifest = JSON.parse(readFileSync(definition, 'utf8'));
	manifest.hooks.hooks.SessionStart[0].hooks[0].command += ' # changed fixture definition';
	writeFileSync(definition, JSON.stringify(manifest));
	const changed = await withCodexRecall(reviewRecall, options);
	assert.equal(changed.status, 'approval-needed');
	assert.ok(changed.hooks.some((h) => h.trust === 'modified'));
	await assert.rejects(
		withCodexRecall((rpc) => changeRecall(rpc, 'approve', review.digest), options),
		/changed since review/
	);
	assert.equal(
		(await withCodexRecall((rpc) => changeRecall(rpc, 'disable', changed.digest), options)).status,
		'installed'
	);
	assert.equal(
		(await withCodexRecall(reviewRecall, options)).status,
		'installed',
		'Recall-off choice must survive a fresh process'
	);
	console.log(
		'codex: native approval persisted; changed definitions required review; stale approval rejected; recall-off persisted'
	);
}

console.log(
	`All three harnesses use AKM ${tools['akm-cli']} / plugin ${tools['akm-opencode']}. Fixtures: ${root}`
);
