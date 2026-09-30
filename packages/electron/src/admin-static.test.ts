import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearClientKey } from '../admin/access.js';
import { importInput, importSignature, invalidateImportPreview } from '../admin/backup.js';
import { loadClientKey } from '../admin/connections.js';
import { bindConfigurationEvents } from '../admin/configuration.js';
import { endpoint, isHealthy, promptVisible } from '../admin/model.js';
import { bindPreferencesEvents, renderPreferences } from '../admin/preferences.js';
import { resetOAuthAttempt } from '../admin/providers.js';
import { renderPhase } from '../admin/runtime.js';
import { createAdminState, state } from '../admin/state.js';
import {
	captureDirtyForms,
	operation,
	restoreDirtyForms,
	setFormClean,
	showClient,
	showView
} from '../admin/ui.js';

const admin = join(import.meta.dir, '..', 'admin');
const html = readFileSync(join(admin, 'index.html'), 'utf8');

// A small DOM double exercises renderer decisions without installing a browser DOM library.
// The real Chromium layout, keyboard, IPC and Docker journey runs in admin:e2e.
class Control {
	id = '';
	type = 'text';
	value = '';
	checked = false;
	disabled = false;
	hidden = false;
	textContent = '';
	className = '';
	dataset: Record<string, string> = {};
	children: Control[] = [];
	attributes = new Map<string, string>();
	listeners = new Map<string, (event: unknown) => unknown>();
	focused = false;

	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	toggleAttribute(name: string, enabled: boolean) {
		if (enabled) this.attributes.set(name, '');
		else this.attributes.delete(name);
	}
	addEventListener(name: string, listener: (event: unknown) => unknown) {
		this.listeners.set(name, listener);
	}
	append(...children: Control[]) {
		this.children.push(...children);
	}
	replaceChildren(...children: Control[]) {
		this.children = children;
	}
	querySelectorAll() {
		return this.children;
	}
	contains(control: Control) {
		return this.children.includes(control);
	}
	focus() {
		this.focused = true;
	}
}

let controls: Map<string, Control>;
let selectors: Map<string, Control[]>;
const savedGlobals = {
	document: globalThis.document,
	window: globalThis.window,
	HTMLInputElement: globalThis.HTMLInputElement
};
function control(id: string): Control {
	const result = controls.get(id);
	if (!result) throw new Error(`Unknown Admin control: ${id}`);
	return result;
}
function selector(name: string, ...elements: Control[]) {
	selectors.set(name, elements);
}

beforeEach(() => {
	Object.assign(state, createAdminState());
	controls = new Map(
		[...html.matchAll(/\bid="([^"]+)"/g)].map((match) => {
			const element = new Control();
			element.id = match[1];
			return [element.id, element];
		})
	);
	selectors = new Map();
	globalThis.document = {
		body: new Control(),
		getElementById: (id: string) => control(id),
		querySelectorAll: (name: string) => selectors.get(name) ?? [],
		createElement: () => new Control()
	} as unknown as Document;
	globalThis.HTMLInputElement = Control as unknown as typeof HTMLInputElement;
	globalThis.window = { confirm: () => false } as unknown as Window & typeof globalThis;
});
afterEach(() => {
	clearTimeout(state.noticeTimer);
	Object.assign(globalThis, savedGlobals);
});

describe('Admin static security boundary', () => {
	it('loads local modules under a closed CSP with no renderer network access', () => {
		const csp = html.match(/content="([^"]+)"/)?.[1] ?? '';
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("connect-src 'none'");
		expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
		const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
		expect(scripts).toHaveLength(1);
		expect(scripts[0][1]).toMatch(/\btype="module"/);
		expect(scripts[0][1]).toMatch(/\bsrc="admin\.js"/);
	});

	it('keeps every credential display masked initially', () => {
		for (const id of [
			'provider-key',
			'bot-token',
			'app-token',
			'credential-key',
			'direct-password',
			'claude-key',
			'mcp-key'
		]) {
			const input = [...html.matchAll(/<input\b[^>]*>/g)].find((match) =>
				match[0].includes(`id="${id}"`)
			)?.[0];
			expect(input).toBeDefined();
			expect(input).toMatch(/\btype="password"/);
			expect(input).toMatch(/\bautocomplete="off"/);
		}
	});

	it('keeps installer and management hidden until the first snapshot', () => {
		for (const id of ['install-section', 'app-shell']) {
			const element = [...html.matchAll(/<[^>]+>/g)].find((match) =>
				match[0].includes(`id="${id}"`)
			)?.[0];
			expect(element).toMatch(/\bhidden\b/);
		}
	});
});

describe('Admin renderer behavior', () => {
	it('uses dialable wildcard and IPv6 addresses and reports unhealthy services', () => {
		expect(endpoint('0.0.0.0', 4096)).toBe('http://127.0.0.1:4096');
		expect(endpoint('::', 9180, '/mcp')).toBe('http://[::1]:9180/mcp');
		expect(endpoint('::1', 4096)).toBe('http://[::1]:4096');
		expect(isHealthy({ state: 'running', health: 'unhealthy' })).toBe(false);
		expect(isHealthy({ state: 'running', health: 'healthy' })).toBe(true);
		expect(isHealthy({ state: 'exited', health: 'healthy' })).toBe(false);
	});

	it('locks duplicate operations and restores controls when the request completes', async () => {
		const enabled = new Control();
		const previouslyDisabled = new Control();
		previouslyDisabled.disabled = true;
		selector('button', enabled, previouslyDisabled);
		let complete!: (value: string) => void;
		const pending = operation(
			'Saving',
			() =>
				new Promise<string>((resolve) => {
					complete = resolve;
				})
		);
		expect(state.operationInFlight).toBe(true);
		expect(enabled.disabled).toBe(true);
		expect(document.body.dataset.busy).toBe('true');
		expect(control('main-content').getAttribute('aria-busy')).toBe('true');
		let duplicateCalled = false;
		expect(
			await operation('Duplicate', () => {
				duplicateCalled = true;
			})
		).toBeUndefined();
		expect(duplicateCalled).toBe(false);
		complete('saved');
		expect(await pending).toBe('saved');
		expect(state.operationInFlight).toBe(false);
		expect(enabled.disabled).toBe(false);
		expect(previouslyDisabled.disabled).toBe(true);
	});

	it('treats failed readiness and thrown errors as persistent accessible failures', async () => {
		const failed = await operation('Checking', async () => ({
			ok: false,
			error: 'Sign-in expired'
		}));
		expect(failed).toBeUndefined();
		expect(control('notice-message').textContent).toBe('Sign-in expired');
		expect(control('notice').getAttribute('role')).toBe('alert');
		expect(control('notice').getAttribute('aria-live')).toBe('assertive');
		expect(control('provider-badge').textContent).toBe('Needs attention');
		expect(state.noticeTimer).toBeUndefined();
		expect(state.operationInFlight).toBe(false);
		await operation('Saving', async () => {
			throw new Error('Docker unavailable');
		});
		expect(control('notice-message').textContent).toBe('Docker unavailable');
	});

	it('shows exactly the appropriate setup shell and gates management navigation', () => {
		const setup = new Control();
		const ready = new Control();
		selector('.setup-only', setup);
		selector('.ready-only', ready);
		renderPhase('not_installed');
		expect(control('install-section').hidden).toBe(false);
		expect(control('app-shell').hidden).toBe(true);
		expect(control('skip-link').getAttribute('href')).toBe('#install-section');
		state.currentSnapshot = { phase: 'setup_incomplete' };
		renderPhase('setup_incomplete');
		expect(control('install-section').hidden).toBe(true);
		expect(control('app-shell').hidden).toBe(false);
		expect(setup.hidden).toBe(false);
		expect(ready.hidden).toBe(true);
		expect(state.currentView).toBe('provider');
		showView('access');
		expect(state.currentView).toBe('provider');
		state.currentSnapshot = { phase: 'ready' };
		renderPhase('ready');
		expect(setup.hidden).toBe(true);
		expect(ready.hidden).toBe(false);
		showView('access', { focus: true });
		expect(state.currentView).toBe('access');
		expect(control('view-title').focused).toBe(true);
	});

	it('switches client recipes with keyboard focus and correct pressed state', () => {
		const openCode = new Control();
		openCode.dataset.clientSetup = 'opencode';
		const claude = new Control();
		claude.dataset.clientSetup = 'claude';
		selector('[data-client-setup]', openCode, claude);
		selector('[data-client-panel]', control('client-opencode'), control('client-claude'));
		control('client-opencode').dataset.clientPanel = 'opencode';
		control('client-claude').dataset.clientPanel = 'claude';
		showClient('claude', { focus: true });
		expect(control('client-opencode').hidden).toBe(true);
		expect(control('client-claude').hidden).toBe(false);
		expect(control('client-claude').focused).toBe(true);
		expect(claude.getAttribute('aria-pressed')).toBe('true');
		expect(openCode.getAttribute('aria-pressed')).toBe('false');
	});

	it('preserves only dirty form drafts, including unchecked preferences', () => {
		control('preferences-form').children = [control('agent-timezone'), control('automatic-memory')];
		control('agent-timezone').value = 'Europe/London';
		control('automatic-memory').type = 'checkbox';
		control('automatic-memory').checked = false;
		state.dirtyForms.add('preferences-form');
		const drafts = captureDirtyForms();
		expect(drafts).toEqual({
			'preferences-form': {
				'agent-timezone': { value: 'Europe/London' },
				'automatic-memory': { checked: false }
			}
		});
		control('agent-timezone').value = 'UTC';
		control('automatic-memory').checked = true;
		restoreDirtyForms(drafts);
		expect(control('agent-timezone').value).toBe('Europe/London');
		expect(control('automatic-memory').checked).toBe(false);
		restoreDirtyForms({ 'preferences-form': { 'assistant-port': { value: '9999' } } });
		expect(control('assistant-port').value).toBe('');
		setFormClean('preferences-form');
		expect(captureDirtyForms()).toEqual({});
	});

	it('requires explicit confirmation before loading a client key and clears revealed values', async () => {
		let loads = 0;
		state.api = {
			credentialKey: async () => {
				loads++;
				return { key: 'private-test-key' };
			}
		};
		control('mcp-credential').value = 'family';
		control('mcp-key').type = 'password';
		await loadClientKey('mcp', false);
		expect(loads).toBe(0);
		globalThis.window.confirm = () => true;
		await loadClientKey('mcp', false);
		expect(loads).toBe(1);
		expect(control('mcp-key').value).toBe('private-test-key');
		expect(control('mcp-key').type).toBe('password');
		control('mcp-key').type = 'text';
		control('show-mcp-key').checked = true;
		clearClientKey('mcp');
		expect(control('mcp-key').value).toBe('');
		expect(control('mcp-key').type).toBe('password');
		expect(control('show-mcp-key').checked).toBe(false);
	});

	it('invalidates restore approval when input changes and excludes opt-ins by default', () => {
		control('import-source').value = ' /tmp/reviewed-backup ';
		const signature = importSignature();
		expect(importInput(false)).toEqual({
			sourceHome: '/tmp/reviewed-backup',
			apply: false,
			includeProviderAuth: false,
			includeUserEnv: false,
			includePortalMaps: false,
			includeOAuth: false
		});
		state.importPreviewDigest = 'reviewed-digest';
		expect(importInput(true).previewDigest).toBe('reviewed-digest');
		control('import-auth').checked = true;
		expect(importSignature()).not.toBe(signature);
		invalidateImportPreview();
		expect(state.importPreviewDigest).toBeNull();
		expect(control('apply-import').disabled).toBe(true);
	});

	it('clears OAuth attempts and evaluates conditional provider prompts', () => {
		const secret = new Control();
		secret.value = 'one-time-value';
		selector('[data-oauth-key]', secret);
		state.activeOAuth = { provider: 'example' };
		control('oauth-code').value = 'one-time-code';
		resetOAuthAttempt();
		expect(state.activeOAuth).toBeNull();
		expect(secret.value).toBe('');
		expect(control('oauth-code').value).toBe('');
		expect(
			promptVisible({ when: { key: 'account', value: 'team', op: 'eq' } }, { account: 'personal' })
		).toBe(false);
		expect(
			promptVisible({ when: { key: 'account', value: 'team', op: 'neq' } }, { account: 'personal' })
		).toBe(true);
	});

	it('renders saved memory, timezone, and independent native remote preferences', () => {
		renderPreferences({
			config: {
				assistant: {
					timezone: 'America/Chicago',
					automaticMemory: false,
					codexRemote: true,
					claudeRemote: false
				}
			}
		});
		expect(control('agent-timezone').value).toBe('America/Chicago');
		expect(control('automatic-memory').checked).toBe(false);
		expect(control('codex-remote').checked).toBe(true);
		expect(control('claude-remote').checked).toBe(false);
	});

	it('submits agent preferences without changing unrelated settings', async () => {
		state.currentConfig = {
			assistant: { bindAddress: '127.0.0.1', port: 4096, timezone: 'UTC', automaticMemory: true },
			gateway: { enabled: false }
		};
		let submitted: unknown;
		state.api = {
			saveConfig: async (value: unknown) => {
				submitted = value;
				throw new Error('Controlled test boundary before backend apply');
			}
		};
		control('agent-timezone').value = ' Europe/London ';
		control('automatic-memory').checked = false;
		control('codex-remote').checked = false;
		control('claude-remote').checked = true;
		bindPreferencesEvents();
		await control('preferences-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(submitted).toEqual({
			assistant: {
				bindAddress: '127.0.0.1',
				port: 4096,
				timezone: 'Europe/London',
				automaticMemory: false,
				codexRemote: false,
				claudeRemote: true
			},
			gateway: { enabled: false }
		});
		expect(state.currentConfig.assistant.timezone).toBe('UTC');
	});

	it('preserves memory and timezone preferences when network settings change', async () => {
		state.currentConfig = {
			assistant: {
				bindAddress: '127.0.0.1',
				port: 4096,
				timezone: 'Europe/London',
				automaticMemory: false
			},
			gateway: { bindAddress: '127.0.0.1', port: 9180, enabled: true }
		};
		let submitted: unknown;
		state.api = {
			saveConfig: async (value: unknown) => {
				submitted = value;
				throw new Error('Controlled test boundary before backend apply');
			}
		};
		control('assistant-bind').value = '127.0.0.1';
		control('assistant-port').value = '4200';
		control('gateway-bind').value = '127.0.0.1';
		control('gateway-port').value = '9200';
		bindConfigurationEvents();
		await control('network-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(submitted).toEqual({
			assistant: {
				bindAddress: '127.0.0.1',
				port: 4200,
				timezone: 'Europe/London',
				automaticMemory: false
			},
			gateway: { bindAddress: '127.0.0.1', port: 9200, enabled: true }
		});
	});
});
