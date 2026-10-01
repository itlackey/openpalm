import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearClientKey, renderCredentials } from '../admin/access.js';
import { importInput, importSignature, invalidateImportPreview } from '../admin/backup.js';
import { loadClientKey } from '../admin/connections.js';
import { bindConfigurationEvents } from '../admin/configuration.js';
import { endpoint, isHealthy, promptVisible } from '../admin/model.js';
import { bindPreferencesEvents, renderPreferences } from '../admin/preferences.js';
import {
	bindRemoteEvents,
	renderRemoteStatus,
	remoteStageText,
	recallStatusLabel
} from '../admin/remote.js';
import { resetOAuthAttempt, renderProviders } from '../admin/providers.js';
import { renderPhase, renderServices } from '../admin/runtime.js';
import { render, refresh } from '../admin/snapshot.js';
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
	open = false;
	get options() {
		return this.children;
	}
	showModal() {
		this.open = true;
	}
	close() {
		this.open = false;
	}

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
	it('requires Docker readiness before installing and refreshes quietly without clearing errors', async () => {
		const snapshot = {
			phase: 'not_installed',
			config: { assistant: { port: 4096 }, gateway: { port: 9180 } },
			installationReadiness: { ok: false, message: 'Docker is stopped.' }
		};
		render(snapshot);
		expect(control('install').disabled).toBe(true);
		expect(control('install-prerequisite').textContent).toBe('Docker is stopped.');
		expect(control('check-prerequisites').hidden).toBe(false);
		state.api = { snapshot: async () => ({ ...snapshot, installationReadiness: { ok: true } }) };
		control('notice').className = 'notice error';
		control('notice').hidden = false;
		await refresh(true);
		expect(control('install').disabled).toBe(false);
		expect(control('check-prerequisites').hidden).toBe(true);
		expect(control('notice').hidden).toBe(false);
		expect(control('refresh').textContent).toBe('Status up to date');
	});

	it('prioritizes startup recovery without claiming that the agent is running', () => {
		renderServices({
			phase: 'setup_incomplete',
			services: [],
			config: {
				gateway: { enabled: false },
				portals: { discord: { enabled: false }, slack: { enabled: false } }
			}
		});
		expect(control('setup-recovery').hidden).toBe(false);
		expect(control('provider-connection').hidden).toBe(true);
		expect(control('setup-runtime').textContent).toBe('Agent startup needs attention.');
		expect(control('view-title').textContent).toBe('Start your agent');
	});

	it('selects an existing native account and hides a redundant single sign-in method', () => {
		renderProviders([
			{
				id: 'example',
				name: 'Example',
				authenticated: true,
				authMethods: [{ index: 0, type: 'api', label: 'API key' }]
			}
		]);
		expect(control('provider').value).toBe('example');
		expect(control('provider-method').value).toBe('0');
		expect(control('provider-method-field').hidden).toBe(true);
		expect(control('provider-status').children[1].textContent).toContain('Verify connection');
	});

	it('offers per-identity management without revealing or retaining a previous key', () => {
		const snapshot = {
			config: {
				credentials: { owner: { policy: 'full' }, guest: { policy: 'chat' } },
				portals: { discord: { credential: 'guest' }, slack: { credential: 'guest' } }
			}
		};
		state.currentSnapshot = snapshot;
		renderCredentials(snapshot);
		const row = control('credential-policies').children[0];
		expect(row.children).toHaveLength(4);
		expect(row.children[0].textContent).toBe('guest');
		control('credential-key').value = 'previous-private-key';
		control('credential-key').type = 'text';
		control('show-credential-key').checked = true;
		row.children[3].listeners.get('click')?.({});
		expect(control('credential-action-name').value).toBe('guest');
		expect(control('credential-key').value).toBe('');
		expect(control('credential-key').type).toBe('password');
		expect(control('credential-action-name').focused).toBe(true);
	});

	it('uses human-readable remote stages and never equates startup with connection readiness', () => {
		expect(recallStatusLabel({ status: 'installed' })).toBe('Installed');
		expect(recallStatusLabel({ status: 'approval-needed' })).toBe('Approval needed');
		expect(recallStatusLabel({ status: 'ready' })).toBe('Ready');
		expect(recallStatusLabel(undefined)).toBe('Not checked');
		expect(remoteStageText({ stage: 'sandbox' })).toContain('safely run Codex');
		expect(remoteStageText({ stage: 'enabling', enabled: true })).toContain(
			'verify a real request'
		);
		expect(remoteStageText({ error: 'Native failure' })).toBe('Native failure');
	});

	it('labels both native remote workers experimental without labeling Claude Desktop MCP', () => {
		for (const name of ['Claude Code', 'Codex'])
			expect(html).toContain(`<h3>${name} <span class="card-label">Experimental</span></h3>`);
		expect(html).toContain('<h3>Claude Desktop</h3>');
		for (const tool of ['claude', 'codex']) {
			const button = new Control();
			button.dataset.remoteConnect = tool;
			selector('[data-remote-enable], [data-remote-connect], [data-codex-recall-review]', button);
			bindRemoteEvents();
			button.listeners.get('click')?.({});
			expect(control('remote-heading').textContent).toContain('(experimental)');
		}
	});

	it('requires explicit remote trust, reports setup failure, and clears native answers before IPC', async () => {
		const button = new Control();
		button.dataset.remoteEnable = 'claude';
		selector('[data-remote-enable], [data-remote-connect], [data-codex-recall-review]', button);
		let calls = 0;
		let answer: unknown;
		state.api = {
			remote: async (request: { action: string; input?: string }) => {
				calls++;
				if (request.action === 'input') {
					answer = request.input;
					expect(control('remote-answer').value).toBe('');
					return {};
				}
				throw new Error('Native setup prerequisite failed.');
			}
		};
		bindRemoteEvents();
		button.listeners.get('click')?.({});
		expect(control('remote-dialog').open).toBe(true);
		expect(control('remote-heading').textContent).toBe('Enable Claude Remote Control (experimental)');
		expect(control('remote-trust').checked).toBe(false);
		expect(control('remote-sandbox-field').hidden).toBe(true);
		expect(control('remote-prompts').hidden).toBe(true);
		expect(control('remote-advanced').open).toBe(false);
		expect(control('remote-send').hidden).toBe(true);
		await control('remote-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls).toBe(0);
		control('remote-trust').checked = true;
		await control('remote-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(control('remote-stage').textContent).toBe('Native setup prerequisite failed.');
		expect(state.operationInFlight).toBe(false);
		control('remote-answer').value = 'private-native-code';
		await control('remote-send').listeners.get('click')?.({});
		expect(answer).toBe('private-native-code');
		await control('remote-cancel').listeners.get('click')?.({});
		expect(control('remote-dialog').open).toBe(false);
	});

	it('requires an explicit Codex recall choice, sends only the current digest, and rejects stale reviews', async () => {
		const button = new Control();
		button.dataset.codexRecallReview = '';
		selector('[data-remote-enable], [data-remote-connect], [data-codex-recall-review]', button);
		const review = {
			status: 'approval-needed',
			digest: 'a'.repeat(64),
			hooks: [
				{
					event: 'sessionStart',
					command: 'literal <script> is text',
					sourcePath: '/plugin',
					hash: 'sha256:abc',
					trust: 'modified',
					enabled: true
				}
			]
		};
		const calls: unknown[] = [];
		state.api = {
			codexRecall: async (request: { action: string; digest?: string }) => {
				calls.push(request);
				if (request.action === 'review') return review;
				throw new Error('AKM hooks changed since review.');
			}
		};
		bindRemoteEvents();
		button.listeners.get('click')?.({});
		await Bun.sleep(1);
		expect(control('remote-recall').checked).toBe(false);
		expect(control('remote-trust-field').hidden).toBe(true);
		expect(control('remote-recall-definitions').value).toContain('literal <script> is text');
		expect(control('remote-recall-status').textContent).toContain('definitions changed');
		await control('remote-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls).toEqual([{ action: 'review' }]);
		control('remote-recall').checked = true;
		await control('remote-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(calls).toEqual([
			{ action: 'review' },
			{ action: 'approve', digest: review.digest, confirmed: true },
			{ action: 'review' }
		]);
		expect(control('remote-stage').textContent).toContain('changed since review');
		expect(control('remote-recall').checked).toBe(false);
		await control('remote-cancel').listeners.get('click')?.({});
	});
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

	it('renders preferences without duplicate remote toggles or false connection readiness', () => {
		const snapshot = {
			config: {
				assistant: {
					timezone: 'America/Chicago',
					automaticMemory: false,
					codexRemote: true,
					claudeRemote: false
				}
			}
		};
		renderPreferences(snapshot);
		renderRemoteStatus(snapshot);
		expect(control('agent-timezone').value).toBe('America/Chicago');
		expect(control('automatic-memory').checked).toBe(false);
		expect(control('codex-remote-status').textContent).toContain('client connection not checked');
		expect(control('claude-remote-status').textContent).toBe('Startup off');
		expect(html).not.toContain('id="codex-remote"');
		expect(html).not.toContain('id="claude-remote"');
	});

	it('submits agent preferences without changing unrelated settings', async () => {
		state.currentConfig = {
			assistant: {
				bindAddress: '127.0.0.1',
				port: 4096,
				timezone: 'UTC',
				automaticMemory: true,
				codexRemote: true,
				claudeRemote: false
			},
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
		bindPreferencesEvents();
		await control('preferences-form').listeners.get('submit')?.({ preventDefault() {} });
		expect(submitted).toEqual({
			assistant: {
				bindAddress: '127.0.0.1',
				port: 4096,
				timezone: 'Europe/London',
				automaticMemory: false,
				codexRemote: true,
				claudeRemote: false
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
