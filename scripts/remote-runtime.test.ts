import { describe, expect, it } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { remoteCommand, remoteEnvironment } from '../containers/assistant/openpalm-remote.mjs';

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error('Remote worker did not reach expected state');
		await Bun.sleep(20);
	}
}

describe('optional native remote workers', () => {
	it('retains native approvals, one Claude session, and no Assistant/portal credentials in child env', () => {
		expect(remoteCommand('codex')).toContain('sandbox_mode="workspace-write"');
		expect(remoteCommand('codex', 'read-only')).toContain('sandbox_mode="read-only"');
		expect(() => remoteCommand('codex', 'danger-full-access')).toThrow();
		expect(remoteCommand('claude')).toEqual([
			'claude',
			'remote-control',
			'--spawn',
			'same-dir',
			'--capacity',
			'1',
			'--permission-mode',
			'default',
			'--no-chrome'
		]);
		expect(() => remoteCommand('untrusted')).toThrow();
		expect(
			remoteEnvironment({
				HOME: '/persist',
				AKM_BUNDLE_DIR: '/stash',
				CLAUDE_CODE_PLUGIN_DIRS: '/opt/openpalm/plugins/akm',
				AKM_AUTO_MEMORY: '0',
				AKM_AUTO_LEARNING: '0',
				BUN_OPTIONS: '--no-env-file',
				OPENCODE_SERVER_PASSWORD: 'secret',
				OPENCODE_SERVER_PASSWORD_FILE: '/secret',
				GUARDIAN_KEY: 'secret',
				DISCORD_TOKEN: 'secret',
				SLACK_TOKEN: 'secret',
				OPENAI_API_KEY: 'secret',
				ANTHROPIC_API_KEY: 'secret',
				CODEX_API_KEY: 'secret',
				CLAUDE_CODE_OAUTH_TOKEN: 'secret'
			})
		).toEqual({
			HOME: '/persist',
			AKM_BUNDLE_DIR: '/stash',
			CLAUDE_CODE_PLUGIN_DIRS: '/opt/openpalm/plugins/akm',
			AKM_AUTO_MEMORY: '0',
			AKM_AUTO_LEARNING: '0',
			BUN_OPTIONS: '--no-env-file',
			DISABLE_AUTOUPDATER: '1'
		});
	});
	it('retries vendor failures independently with bounded private logs and clean shutdown', async () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-remote-test-'));
		const status = join(root, 'state', 'codex.json');
		const log = join(root, 'state', 'codex.log');
		writeFileSync(
			join(root, 'codex'),
			'#!/usr/bin/env node\nconst fs=require("node:fs"); fs.appendFileSync("attempts", "1"); console.log("pairing-private " + "茶".repeat(100000)); console.log(process.env.OPENCODE_SERVER_PASSWORD ?? "no-assistant-password"); process.exit(23);'
		);
		chmodSync(join(root, 'codex'), 0o700);
		const module = join(import.meta.dir, '../containers/assistant/openpalm-remote.mjs');
		const child = Bun.spawn(
			[
				process.execPath,
				'--eval',
				`import {superviseRemote} from ${JSON.stringify(module)}; await superviseRemote('codex', { directory: ${JSON.stringify(join(root, 'state'))}, workdir: ${JSON.stringify(root)}, retryMs: 100, env: { PATH: ${JSON.stringify(`${root}:${process.env.PATH}`)}, OPENCODE_SERVER_PASSWORD: 'must-not-leak' } });`
			],
			{ stdout: 'pipe', stderr: 'pipe' }
		);
		try {
			let completedLog = '';
			let exitCode: number | undefined;
			await until(() => {
				if (!existsSync(status) || !existsSync(join(root, 'attempts'))) return false;
				if (statSync(join(root, 'attempts')).size < 2) return false;
				const snapshot = JSON.parse(readFileSync(status, 'utf8'));
				// A retry replaces the log. Assert the completed snapshot observed
				// here, not a later read which may belong to the next attempt.
				completedLog = readFileSync(log, 'utf8');
				exitCode = snapshot.exitCode;
				return (
					snapshot.state === 'waiting-to-retry' && completedLog.includes('no-assistant-password')
				);
			});
			expect(exitCode).toBe(23);
			expect(completedLog).toContain('no-assistant-password');
			expect(completedLog).not.toContain('must-not-leak');
			expect(statSync(log).size).toBeLessThanOrEqual(65_536);
			expect(statSync(log).mode & 0o777).toBe(0o600);
			expect(statSync(status).mode & 0o777).toBe(0o600);
			expect(statSync(join(root, 'state')).mode & 0o777).toBe(0o700);
			child.kill('SIGTERM');
			expect(await child.exited).toBe(0);
			expect(JSON.parse(readFileSync(status, 'utf8')).state).toBe('stopped');
			expect(await new Response(child.stdout).text()).toBe('');
			expect(await new Response(child.stderr).text()).toBe('');
		} finally {
			child.kill();
			await child.exited;
			rmSync(root, { recursive: true, force: true });
		}
	});
	it('terminates a running vendor process and its spawned session on shutdown', async () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-remote-child-test-'));
		const pidFile = join(root, 'child.pid');
		const session =
			'process.on("SIGTERM",()=>{}); require("node:fs").writeFileSync("ready","1"); setInterval(()=>{},1000)';
		writeFileSync(
			join(root, 'claude'),
			[
				'#!/usr/bin/env node',
				'const {spawn}=require("node:child_process"); const {writeFileSync}=require("node:fs");',
				'const child=spawn(process.execPath,["-e",' +
					JSON.stringify(session) +
					'], {stdio:"inherit"});',
				'writeFileSync("child.pid",String(child.pid)); setInterval(()=>{},1000);'
			].join('\n')
		);
		chmodSync(join(root, 'claude'), 0o700);
		const module = join(import.meta.dir, '../containers/assistant/openpalm-remote.mjs');
		const child = Bun.spawn(
			[
				process.execPath,
				'--eval',
				`import {superviseRemote} from ${JSON.stringify(module)}; await superviseRemote('claude', { directory: ${JSON.stringify(join(root, 'state'))}, workdir: ${JSON.stringify(root)}, env: { PATH: ${JSON.stringify(`${root}:${process.env.PATH}`)} } });`
			],
			{ stdout: 'pipe', stderr: 'pipe' }
		);
		try {
			await until(() => existsSync(pidFile) && existsSync(join(root, 'ready')));
			const pid = Number(readFileSync(pidFile, 'utf8'));
			child.kill('SIGTERM');
			expect(await child.exited).toBe(0);
			await until(() => {
				try {
					return readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z';
				} catch {
					return true;
				}
			});
			expect(JSON.parse(readFileSync(join(root, 'state', 'claude.json'), 'utf8')).state).toBe(
				'stopped'
			);
		} finally {
			child.kill();
			await child.exited;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
