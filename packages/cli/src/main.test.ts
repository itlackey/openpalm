import { describe, expect, it } from 'bun:test';

import { helpText } from './main.js';

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
	});
});
