import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const admin = join(import.meta.dir, '..', 'admin');

describe('Admin static security contract', () => {
	it('keeps a closed CSP and external script file', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		expect(html).toContain("default-src 'self'");
		expect(html).toContain("connect-src 'none'");
		expect(html).toContain('<script src="admin.js"></script>');
		expect(html).not.toMatch(/<script(?![^>]*src=)[^>]*>/);
	});

	it('renders provider and portal secrets only into password inputs', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		for (const id of ['provider-key', 'bot-token', 'app-token', 'credential-key']) {
			expect(html).toContain(`id="${id}" type="password"`);
		}
		const script = readFileSync(join(admin, 'admin.js'), 'utf8');
		expect(script).toContain("window.confirm('Reveal this bearer key?");
	});

	it('exposes every backup opt-in and lets an operator remove a portal mapping', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		for (const id of [
			'backup-auth',
			'backup-env',
			'backup-maps',
			'import-auth',
			'import-env',
			'import-maps'
		]) {
			expect(html).toContain(`id="${id}"`);
		}
		const script = readFileSync(join(admin, 'admin.js'), 'utf8');
		expect(script).toContain('Portal default (remove mapping)');
		expect(script).toContain("username: byId('mapping-credential').value || undefined");
	});
});
