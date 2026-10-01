import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	beginRemoteEnable,
	disableRemote,
	buildComposeOptions,
	composeConfigJson,
	createOpenPalmState,
	readStackConfig,
	acquireStackLock,
	releaseStackLock
} from '@openpalm/lib';
import { remoteExecArguments, describeRecall } from './remote.js';
import { bootstrapInstall } from './install.js';

const original = {
	home: process.env.OP_HOME,
	repo: process.env.OPENPALM_REPO_ROOT,
	docker: process.env.OP_DOCKER_BIN
};
afterEach(() => {
	for (const [key, value] of [
		['OP_HOME', original.home],
		['OPENPALM_REPO_ROOT', original.repo],
		['OP_DOCKER_BIN', original.docker]
	]) {
		if (value === undefined) delete process.env[key as string];
		else process.env[key as string] = value;
	}
});

async function guidedFixture(failure = false) {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-guided-remote-fixture-'));
	process.env.OP_HOME = join(root, 'home');
	process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');
	await bootstrapInstall({ start: false });
	const state = createOpenPalmState();
	const resolved = await composeConfigJson(buildComposeOptions(state));
	if (!resolved.ok) throw new Error(resolved.stderr);
	const docker = join(root, 'docker');
	writeFileSync(
		docker,
		`#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes('config')) {
 const config=${JSON.stringify(resolved.config)};
 Object.assign(config.services.assistant.environment,{OPENPALM_CODEX_REMOTE:process.env.OP_CODEX_REMOTE,OPENPALM_CLAUDE_REMOTE:process.env.OP_CLAUDE_REMOTE,OPENPALM_CODEX_SANDBOX:process.env.OP_CODEX_SANDBOX});
 console.log(JSON.stringify(config));
} else if(args.includes('pair')) {
 console.log(JSON.stringify({pairingCode:'private-fixture-code'}));
} else if(args.includes('logs')) {
 console.log('https://claude.ai/code/background-fixture');
} else if(args.includes('exec')) {
 ${
		failure
			? 'console.log(JSON.stringify({error:"Fixture sandbox denied"})); process.exit(1);'
			: `
 console.log(JSON.stringify({stage:'sign-in',output:'Private fixture prompt\\n'}));
 setInterval(()=>{},1000);
 const reader=require('node:readline').createInterface({input:process.stdin});
 reader.on('line', line=>{const value=JSON.parse(line); if(value.cancel)process.exit(1); if(value.input==='human-approved'){console.log(JSON.stringify({ready:true}));setTimeout(()=>process.exit(0),30);}});
 `
 }
}
`
	);
	chmodSync(docker, 0o700);
	process.env.OP_DOCKER_BIN = docker;
	return state;
}

describe('native remote commands', () => {
	it('explains native recall commands and data access without requiring a Codex slash command', () => {
		const text = describeRecall({
			status: 'approval-needed',
			digest: 'a'.repeat(64),
			hooks: [
				{
					key: 'akm',
					hash: 'sha256:abc',
					event: 'sessionStart',
					command: 'sh /actual/akm-hook.sh session-start',
					sourcePath: '/actual/plugin.json',
					enabled: true,
					trust: 'untrusted'
				}
			]
		});
		expect(text).toContain('sh /actual/akm-hook.sh session-start');
		expect(text).toContain('search/embedding endpoints');
		expect(text).toContain('does not grant tool permissions');
		expect(text).not.toContain('/hooks');
	});
	it('guides sign-in and enables only after native readiness, preserving credentials and releasing the lifecycle lock', async () => {
		const state = await guidedFixture();
		const keyFile = join(state.homeDir, 'state/credentials/owner/key');
		const key = readFileSync(keyFile);
		const session = await beginRemoteEnable(state, 'codex', {
			trusted: true,
			sandbox: 'read-only'
		});
		expect(acquireStackLock(state.dataDir)).toBeNull();
		expect(() => session.input('bad\ninput')).toThrow();
		const promptDeadline = Date.now() + 2000;
		while (session.snapshot().stage !== 'sign-in') {
			if (Date.now() >= promptDeadline) throw new Error('Fixture prompt did not start.');
			await Bun.sleep(5);
		}
		session.input('human-approved');
		const result = await session.done;
		expect(result).toMatchObject({ enabled: true, running: false, stage: 'enabled' });
		expect(result.output).toContain('private-fixture-code');
		const config = readStackConfig(state.homeDir);
		expect(config.ok && config.config.assistant).toMatchObject({
			codexRemote: true,
			claudeRemote: false,
			codexSandbox: 'read-only'
		});
		expect(readFileSync(keyFile)).toEqual(key);
		const lock = acquireStackLock(state.dataDir);
		expect(lock).not.toBeNull();
		releaseStackLock(lock);
		await disableRemote(state, 'codex');
		const disabled = readStackConfig(state.homeDir);
		expect(disabled.ok && disabled.config.assistant).toMatchObject({
			codexRemote: false,
			codexSandbox: 'read-only'
		});
		expect(readFileSync(keyFile)).toEqual(key);
	});
	it('keeps startup off after native failure or cancellation', async () => {
		let state = await guidedFixture(true);
		let session = await beginRemoteEnable(state, 'claude', { trusted: true });
		expect(await session.done).toMatchObject({
			enabled: false,
			running: false,
			error: 'Fixture sandbox denied'
		});
		delete process.env.OP_DOCKER_BIN;
		state = await guidedFixture();
		session = await beginRemoteEnable(state, 'claude', { trusted: true });
		session.cancel();
		expect(await session.done).toMatchObject({ enabled: false, running: false });
		const config = readStackConfig(state.homeDir);
		expect(config.ok && config.config.assistant.claudeRemote).toBe(false);
	});
	it('rolls startup back off if cancelled after native setup, during background pairing', async () => {
		const state = await guidedFixture();
		const session = await beginRemoteEnable(state, 'claude', {
			trusted: true,
			update(progress) {
				if (progress.stage === 'pairing') session.cancel();
			}
		});
		const deadline = Date.now() + 2000;
		while (session.snapshot().stage !== 'sign-in') {
			if (Date.now() >= deadline) throw new Error('Fixture prompt did not start.');
			await Bun.sleep(5);
		}
		session.input('human-approved');
		expect(await session.done).toMatchObject({ enabled: false, running: false, stage: 'failed' });
		const config = readStackConfig(state.homeDir);
		expect(config.ok && config.config.assistant.claudeRemote).toBe(false);
		const lock = acquireStackLock(state.dataDir);
		expect(lock).not.toBeNull();
		releaseStackLock(lock);
	});
	it('delegates sign-in, pairing, and status to native commands without shell strings', () => {
		expect(remoteExecArguments('setup', 'codex')).toEqual(['codex', 'login', '--device-auth']);
		expect(remoteExecArguments('setup', 'claude')).toEqual(['claude']);
		expect(remoteExecArguments('pair', 'codex')).toEqual([
			'codex',
			'remote-control',
			'pair',
			'--json'
		]);
		expect(remoteExecArguments('pair', 'claude')).toEqual(['openpalm-remote', 'claude', 'logs']);
		expect(remoteExecArguments('logs', 'codex')).toEqual(['openpalm-remote', 'codex', 'logs']);
		expect(remoteExecArguments('status', 'claude')).toEqual([
			'openpalm-remote',
			'claude',
			'status'
		]);
		for (const tool of [
			'codex; touch /tmp/pwn',
			'claude --dangerously-skip-permissions',
			'../claude'
		])
			expect(() => remoteExecArguments('setup', tool)).toThrow('Choose codex or claude');
		expect(() => remoteExecArguments('arbitrary', 'codex')).toThrow();
	});
});
