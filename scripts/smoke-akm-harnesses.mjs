#!/usr/bin/env bun
// Run inside the built Assistant image, without vendor credentials or a model.
// These are real harnesses and the real AKM CLI, not a replacement plugin loader.
import assert from 'node:assert/strict';
import {
	appendFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

async function waitFor(probe, label) {
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
	throw new Error(`Timed out: ${label}; fixtures retained at ${root}`);
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
	const proc = Bun.spawn(
		[
			'opencode',
			'run',
			'--model',
			'openai/gpt-5-nano',
			'--agent',
			'build',
			'--format',
			'json',
			prompt
		],
		{ cwd: f.cwd, env: f.env, stdout: 'ignore', stderr: 'ignore' }
	);
	try {
		await waitFor(
			() => recalled(join(f.dir, 'state/akm-opencode/events.jsonl'), 'opencode'),
			'OpenCode recall'
		);
	} finally {
		proc.kill();
		await proc.exited;
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
	const proc = Bun.spawn(['claude', '-p', prompt, '--debug-file', debug], {
		cwd: f.cwd,
		env: f.env,
		stdout: 'pipe',
		stderr: 'pipe'
	});
	try {
		await waitFor(
			() => recalled(join(f.dir, 'state/akm-claude/events.jsonl'), 'claude-code'),
			'Claude recall'
		);
		assert.match(readFileSync(debug, 'utf8'), /Hook SessionStart:startup \(SessionStart\) success/);
	} finally {
		proc.kill();
		await proc.exited;
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
	const server = Bun.spawn(['codex', 'app-server'], {
		cwd: f.cwd,
		env: f.env,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'ignore'
	});
	const pending = new Map();
	const reader = (async () => {
		let buffer = '';
		for await (const chunk of server.stdout) {
			buffer += new TextDecoder().decode(chunk);
			for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				try {
					const message = JSON.parse(line);
					pending.get(message.id)?.(message);
				} catch {
					/* non-RPC output */
				}
			}
		}
	})();
	let id = 0;
	const rpc = async (method, params) => {
		const requestId = ++id;
		let answer;
		pending.set(requestId, (response) => {
			answer = response;
		});
		server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
		server.stdin.flush();
		const response = await waitFor(() => answer, method);
		assert.ok(!response.error, JSON.stringify(response.error));
		return response.result;
	};
	let hooks;
	try {
		await rpc('initialize', { clientInfo: { name: 'openpalm-smoke', version: '1' } });
		server.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');
		server.stdin.flush();
		hooks = (await rpc('hooks/list', { cwds: [f.cwd] })).data[0].hooks;
		assert.deepEqual(hooks.map((h) => h.eventName).sort(), ['sessionStart', 'userPromptSubmit']);
		assert.ok(
			hooks.every((h) => h.trustStatus === 'untrusted'),
			'Production defaults must not pre-trust hooks'
		);
	} finally {
		server.kill();
		await server.exited;
		await reader;
	}
	// Test-only native /hooks trust state, isolated from runtime/user homes.
	const config = join(f.env.CODEX_HOME, 'config.toml');
	writeFileSync(
		config,
		'model="offline"\nmodel_provider="offline"\n' +
			readFileSync(config, 'utf8') +
			'\n[model_providers.offline]\nname="offline"\nbase_url="http://127.0.0.1:9/v1"\n' +
			'wire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n'
	);
	for (const hook of hooks)
		appendFileSync(
			config,
			`\n[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash=${JSON.stringify(hook.currentHash)}\n`
		);
	const proc = Bun.spawn(
		['codex', 'exec', '--skip-git-repo-check', '--json', '--sandbox', 'workspace-write', prompt],
		{ cwd: f.cwd, env: f.env, stdout: 'ignore', stderr: 'ignore' }
	);
	try {
		await waitFor(
			() => recalled(join(f.env.CODEX_HOME, 'plugins/data/akm-akm-plugins/events.jsonl'), 'codex'),
			'Codex recall'
		);
	} finally {
		proc.kill();
		await proc.exited;
	}
}

console.log(
	`All three harnesses use AKM ${tools['akm-cli']} / plugin ${tools['akm-opencode']}. Fixtures: ${root}`
);
