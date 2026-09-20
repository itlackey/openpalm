import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const admin = join(import.meta.dir, '..', 'admin');
const source = import.meta.dir;

describe('Admin static security contract', () => {
	it('lets the Electron entry module finish before waiting for app readiness', () => {
		const main = readFileSync(join(source, 'admin-main.ts'), 'utf8');
		expect(main).toContain('void app.whenReady().then');
		expect(main).not.toContain('await app.whenReady()');
		const e2e = readFileSync(join(source, 'admin-e2e.ts'), 'utf8');
		expect(e2e).toContain('void main();');
	});

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

	it('collects local ports before starting a fresh installation', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		expect(html).toContain('id="install-form"');
		expect(html).toContain('id="install-assistant-port"');
		expect(html).toContain('id="install-gateway-port"');
		const script = readFileSync(join(admin, 'admin.js'), 'utf8');
		expect(script).toContain('api.install(config)');
		expect(script).toContain('Assistant and Guardian ports must be different.');
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
