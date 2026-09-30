import { describe, expect, it } from 'bun:test';
import { remoteExecArguments } from './remote.js';

describe('native remote commands', () => {
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
