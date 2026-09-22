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
		const app = readFileSync(join(source, 'admin-app.ts'), 'utf8');
		expect(app).toContain("url.protocol !== 'https:' || url.username || url.password");
		expect(app).toContain('shell.openExternal(externalUrl(url))');
	});

	it('renders provider and portal secrets only into password inputs', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		for (const id of [
			'provider-key',
			'bot-token',
			'app-token',
			'credential-key',
			'direct-password',
			'claude-key',
			'mcp-key'
		]) {
			expect(html).toContain(`id="${id}" type="password"`);
		}
		const script = readFileSync(join(admin, 'admin.js'), 'utf8');
		expect(script).toContain("window.confirm('Reveal this access key?");
	});

	it('keeps first-install networking behind an advanced disclosure', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		expect(html).toContain('id="install-form"');
		expect(html).toContain('<summary>Advanced network settings</summary>');
		expect(html).toContain('id="install-assistant-port"');
		expect(html).toContain('id="install-gateway-port"');
		const script = readFileSync(join(admin, 'admin.js'), 'utf8');
		expect(script).toContain('api.install(config)');
		expect(script).toContain('Assistant and protected-access ports must be different.');
	});

	it('renders exactly one explicit setup phase and fails closed while loading', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		expect(html).toContain('id="loading-state"');
		expect(html).toContain('id="install-section" class="welcome-shell" tabindex="-1" hidden');
		expect(html).toContain('id="app-shell" class="app-shell" hidden');
		expect(html).toContain('id="error-state" class="centered-state error-state"');
		expect(html).toContain('id="retry-snapshot"');
		const script = readFileSync(join(admin, 'admin.js'), 'utf8');
		expect(script).toContain('renderPhase(snapshot.phase)');
		expect(script).toContain("phase === 'setup_incomplete'");
		expect(script).toContain("phase === 'ready'");
		expect(script).toContain("setSkipTarget(phase === 'not_installed' ? 'install-section'");
		expect(script).toContain('if (currentSnapshot)');
	});

	it('treats failed provider readiness as an error and locks duplicate operations', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		expect(html).toContain('id="notice" class="notice" role="status"');
		const script = readFileSync(join(admin, 'admin.js'), 'utf8');
		expect(script).toContain('if (!result.ok) throw new Error');
		expect(script).toContain("for (const control of all('[data-oauth-key]')) control.value = ''");
		expect(script).toContain("element.setAttribute('role', 'alert')");
		expect(script).toContain('if (operationInFlight) return undefined');
		expect(script).toContain('document.body.dataset.busy = String(value)');
		expect(script).toContain("currentSnapshot?.phase === 'setup_incomplete'");
		expect(script).toContain("'Verifying your existing provider sign-in'");
	});

	it('validates portal-specific secrets before enabling an adapter', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		expect(html).toContain('id="discord-access-disclosure"');
		expect(html).toContain('id="slack-access-disclosure"');
		expect(html).toContain('data-token-target="discord"');
		expect(html).toContain('data-token-target="slack"');
		const app = readFileSync(join(source, 'admin-app.ts'), 'utf8');
		expect(app).toContain('Discord bot token is required.');
		expect(app).toContain('Both Slack tokens are required the first time.');
		expect(app).toContain('Enter at least one Slack token to replace.');
		expect(app).toContain("if (input.portal === 'slack' && hasAppToken)");
		const script = readFileSync(join(admin, 'admin.js'), 'utf8');
		expect(script).toContain("showPortalTokenForm('discord')");
		expect(script).toContain("byId('slack-access-disclosure').open = true");
	});

	it('provides task navigation, conditional connections, and visible focus', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		for (const view of ['overview', 'provider', 'connections', 'access', 'backup', 'diagnostics']) {
			expect(html).toContain(`data-view="${view}"`);
		}
		const script = readFileSync(join(admin, 'admin.js'), 'utf8');
		expect(script).toContain("byId('discord-settings').hidden = !byId('discord').checked");
		expect(script).toContain("byId('slack-settings').hidden = !byId('slack').checked");
		expect(html).toContain('id="connections-form"');
		expect(html).toContain('id="access-form"');
		expect(html).toContain('id="network-form"');
		expect(html).not.toContain('id="config-form"');
		expect(script).toContain('captureDirtyForms()');
		expect(script).toContain("dirtyForms.add('connections-form')");
		const css = readFileSync(join(admin, 'admin.css'), 'utf8');
		expect(css).toContain('outline: 3px solid var(--focus)');
		expect(css).toContain('min-height: 44px');
		expect(css).toContain('#primary-nav:not([hidden])');
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
		expect(script).toContain("const username = byId('mapping-credential').value || undefined");
		expect(script).toContain('importPreviewSignature !== importSignature()');
		expect(script).toContain('previewDigest: importPreviewDigest');
		expect(script).toContain('importPreviewDigest = result.digest');
	});

	it('provides complete client connection recipes and explicit secret retrieval', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		for (const id of [
			'direct-url',
			'direct-username',
			'load-direct-password',
			'install-claude-extension',
			'claude-url',
			'claude-credential',
			'mcp-url',
			'mcp-credential'
		]) {
			expect(html).toContain(`id="${id}"`);
		}
		const app = readFileSync(join(source, 'admin-app.ts'), 'utf8');
		expect(app).toContain("connectionDetails(current.homeDir, 'opencode'");
		expect(app).toContain('clipboard.writeText(value)');
	});

	it('uses OpenCode native browser sign-in for the selected installation', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		expect(html).toContain('id="start-provider-oauth"');
		expect(html).toContain('id="finish-provider-oauth"');
		expect(html).not.toContain('openpalm provider login');
		const app = readFileSync(join(source, 'admin-app.ts'), 'utf8');
		expect(app).toContain('beginProviderOAuth(');
		expect(app).toContain('completeProviderOAuth(');
	});

	it('offers startup recovery and native backup directory selection', () => {
		const html = readFileSync(join(admin, 'index.html'), 'utf8');
		expect(html).toContain('id="setup-recovery"');
		expect(html).toContain('id="recovery-form"');
		expect(html).toContain('id="choose-backup-destination"');
		expect(html).toContain('id="choose-import-source"');
		const app = readFileSync(join(source, 'admin-app.ts'), 'utf8');
		expect(app).toContain('dialog.showOpenDialog');
	});
});
