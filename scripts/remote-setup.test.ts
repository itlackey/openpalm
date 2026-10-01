import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { guidedSetup, setupCommands } from '../containers/assistant/openpalm-remote-setup.mjs';

function fixture(tool: string, source: string) {
	const root = mkdtempSync(join(tmpdir(), 'openpalm-native-setup-test-'));
	writeFileSync(join(root, tool), `#!/usr/bin/env node\n${source}`);
	chmodSync(join(root, tool), 0o700);
	return { root, env: { PATH: `${root}:${process.env.PATH}` } };
}

describe('guided native prompt bridge', () => {
	it('uses native sandbox and account login commands, never a shell or bypass flag', () => {
		expect(setupCommands('codex', 'read-only')[0]).toEqual([
			'sandbox',
			['codex', '-c', 'sandbox_mode="read-only"', 'sandbox', '/usr/bin/true']
		]);
		expect(() => setupCommands('codex', 'danger-full-access')).toThrow();
		expect(() => setupCommands('shell', 'workspace-write')).toThrow();
		expect(setupCommands('claude', 'workspace-write')[0]).toEqual([
			'sign-in',
			['claude', 'auth', 'login', '--claudeai']
		]);
	});
	it('fails sandbox preflight before opening sign-in', async () => {
		const { root, env } = fixture('codex', 'console.log("namespace denied"); process.exit(1);');
		const events: Array<Record<string, unknown>> = [];
		await expect(
			guidedSetup('codex', 'workspace-write', {
				workdir: root,
				env,
				input: new PassThrough(),
				emit: (event: Record<string, unknown>) => events.push(event),
				timeoutMs: 3000
			})
		).rejects.toThrow('sandbox check failed');
		expect(events.filter((event) => event.stage).map((event) => event.stage)).toEqual(['sandbox']);
		expect(events.some((event) => event.ready)).toBe(false);
	});
	it('provides a real PTY and relays explicit human trust and consent answers', async () => {
		const { root, env } = fixture(
			'claude',
			`
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(11);
if (process.argv[2] === 'auth') { console.log('signed in'); process.exit(0); }
console.log('Trust /work? [y/N]');
const reader = require('node:readline').createInterface({input:process.stdin});
let count=0;
reader.on('line', line => {
 if(line!=='y') process.exit(1);
 if(++count===1) console.log('Enable Remote Control? (y/n)');
 else {
  process.stdout.write('https://claude.ai/co');
  setTimeout(()=>console.log('de/session-test'),20);
  setInterval(()=>{},1000);
 }
});`
		);
		const input = new PassThrough();
		const events: Array<Record<string, unknown>> = [];
		let trustAnswered = false;
		let consentAnswered = false;
		await guidedSetup('claude', 'workspace-write', {
			workdir: root,
			env,
			input,
			timeoutMs: 6000,
			emit(event: Record<string, unknown>) {
				events.push(event);
				if (typeof event.output !== 'string') return;
				if (event.output.includes('Trust /work?') && !trustAnswered) {
					trustAnswered = true;
					input.write(`${JSON.stringify({ input: 'y' })}\n`);
				}
				if (event.output.includes('Enable Remote Control?') && !consentAnswered) {
					consentAnswered = true;
					input.write(`${JSON.stringify({ input: 'y' })}\n`);
				}
			}
		});
		expect(events.some((event) => event.ready === true)).toBe(true);
		expect(events.some((event) => String(event.output).includes('https://claude.ai/code/'))).toBe(
			false
		);
	});
	it('cancels a waiting prompt on channel close', async () => {
		const { root, env } = fixture(
			'claude',
			'if(process.argv[2] === "auth") process.exit(0); console.log("Trust /work?"); setInterval(()=>{},1000);'
		);
		const input = new PassThrough();
		await expect(
			guidedSetup('claude', 'workspace-write', {
				workdir: root,
				env,
				input,
				timeoutMs: 4000,
				emit(event: Record<string, unknown>) {
					if (String(event.output).includes('Trust')) input.end();
				}
			})
		).rejects.toThrow('cancelled');
	});
	it('reuses native account sign-in without silently accepting workspace trust', async () => {
		const { root, env } = fixture(
			'claude',
			`
if (process.argv[2] === 'auth') {
 if (process.argv[3] !== 'status') process.exit(12);
 console.log(JSON.stringify({loggedIn:true})); process.exit(0);
}
console.log('Trust /work? [y/N]');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 if (line === 'n') process.exit(1);
 else process.exit(13);
});`
		);
		const input = new PassThrough();
		const events: Array<Record<string, unknown>> = [];
		await expect(
			guidedSetup('claude', 'workspace-write', {
				workdir: root,
				env,
				input,
				timeoutMs: 4000,
				emit(event: Record<string, unknown>) {
					events.push(event);
					if (String(event.output).includes('Trust'))
						input.write(`${JSON.stringify({ input: 'n' })}\n`);
				}
			})
		).rejects.toThrow('Native trust-and-consent failed');
		expect(events.filter((event) => event.stage).map((event) => event.stage)).toEqual([
			'trust-and-consent'
		]);
		expect(events.some((event) => event.ready)).toBe(false);
	});
});
