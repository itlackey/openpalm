import { describe, expect, it, spyOn } from 'bun:test';

import { helpText, main } from './main.js';

describe('CLI help', () => {
	it('lists the complete command surface', () => {
		const help = helpText();
		for (const command of [
			'install',
			'setup',
			'provider',
			'backup',
			'connect',
			'import',
			'task',
			'update',
			'addon',
			'credential',
			'portal',
			'config',
			'doctor',
			'start',
			'stop',
			'restart',
			'logs',
			'status'
		]) {
			expect(help).toContain(command);
		}
		expect(help).not.toContain('uninstall');
		expect(helpText('addon')).toContain('gateway|discord|slack');
		expect(helpText('config')).toContain('assistant');
		expect(helpText('config')).toContain('portal <discord|slack> --credential <username>');
		expect(helpText('credential')).toContain('set-policy');
		expect(helpText('provider')).toContain('login');
		expect(helpText('import')).toContain('--dry-run');
		expect(helpText('task')).toContain('create <id>');
		for (const command of ['remote', 'setup', 'config']) {
			expect(helpText(command)).toContain('Codex and Claude Code native remote access is experimental');
		}
	});
	it('shows nested remote help without running setup or requiring a tool', async () => {
		const output = spyOn(console, 'log').mockImplementation(() => {});
		try {
			await main(['remote', 'enable', '--help']);
			await main(['remote', 'enable', 'claude', '--help']);
			expect(output).toHaveBeenCalledTimes(2);
			expect(output.mock.calls[0]?.[0]).toContain('remote enable');
			expect(output.mock.calls[1]?.[0]).toContain('experimental');
		} finally {
			output.mockRestore();
		}
	});
});
