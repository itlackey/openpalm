import { describe, expect, it } from 'bun:test';

import { helpText } from './main-lean.js';

describe('lean CLI help', () => {
	it('lists the complete active command surface without loading legacy commands', () => {
		const help = helpText();
		for (const command of [
			'install',
			'update',
			'addon',
			'credential',
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
	});
});
