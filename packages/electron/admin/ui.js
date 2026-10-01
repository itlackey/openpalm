import { readinessResult } from './model.js';
import { renderReadiness } from './providers.js';
import { renderRuntimeControls } from './runtime.js';
import { refresh, render } from './snapshot.js';
import { managedFormIds, state, viewMeta } from './state.js';

export const byId = (id) => document.getElementById(id);

export const all = (selector) => [...document.querySelectorAll(selector)];

export function message(error) {
	return error instanceof Error ? error.message : String(error);
}

export function setText(id, value) {
	byId(id).textContent = value;
}

export function setBadge(element, text, tone = 'neutral') {
	element.textContent = text;
	element.className = `status-badge ${tone}`;
}

export function notice(value, tone = 'success', options = {}) {
	const element = byId('notice');
	clearTimeout(state.noticeTimer);
	if (!value) {
		element.hidden = true;
		byId('install-status').hidden = true;
		return;
	}
	setText('notice-message', value);
	const installing = state.currentSnapshot?.phase === 'not_installed';
	setText('install-status', installing ? value : '');
	byId('install-status').hidden = !installing;
	byId('install-status').className = `help-text${tone === 'error' ? ' danger-text' : ''}`;
	byId('install-status').setAttribute('role', tone === 'error' ? 'alert' : 'status');
	element.className = `notice ${tone}`;
	element.hidden = installing;
	if (tone === 'error') {
		element.setAttribute('role', 'alert');
		element.setAttribute('aria-live', 'assertive');
		setText('notice-icon', '!');
	} else {
		element.setAttribute('role', 'status');
		element.setAttribute('aria-live', 'polite');
		setText('notice-icon', tone === 'success' ? '✓' : '●');
	}
	if (tone === 'success' && options.persist !== true) {
		state.noticeTimer = setTimeout(() => {
			element.hidden = true;
		}, 3500);
	}
}

export function setBusy(value) {
	state.operationInFlight = value;
	document.body.dataset.busy = String(value);
	const busyRegion = !state.currentSnapshot
		? byId('instance-welcome')
		: state.currentSnapshot?.phase === 'not_installed'
			? byId('install-section')
			: byId('main-content');
	busyRegion?.setAttribute('aria-busy', String(value));
	if (value) {
		state.disabledButtons = all('button').map((button) => ({ button, disabled: button.disabled }));
		for (const { button } of state.disabledButtons) button.disabled = true;
	} else {
		for (const { button, disabled } of state.disabledButtons) button.disabled = disabled;
		state.disabledButtons = [];
		if (state.currentSnapshot) renderRuntimeControls(state.currentSnapshot);
	}
}

export async function operation(progress, action, success = `${progress} complete.`) {
	if (state.operationInFlight) return undefined;
	setBusy(true);
	notice(`${progress}…`, 'progress', { persist: true });
	try {
		const result = await action();
		if (readinessResult(result)) {
			state.lastReadiness = result;
			renderReadiness(result);
			if (!result.ok) {
				notice('');
				return undefined;
			}
		}
		if (result?.phase && result?.config) render(result);
		notice(success, 'success');
		return result;
	} catch (error) {
		notice(message(error), 'error', { persist: true });
		return undefined;
	} finally {
		setBusy(false);
	}
}

export function setOptions(select, values, selected) {
	select.replaceChildren();
	for (const entry of values) {
		const option = document.createElement('option');
		option.value = typeof entry === 'string' ? entry : entry.value;
		option.textContent = typeof entry === 'string' ? entry : entry.label;
		select.append(option);
	}
	if (selected !== undefined && [...select.options].some((option) => option.value === selected)) {
		select.value = selected;
	}
}

export function formDraft(form) {
	const values = {};
	for (const control of form.elements ||
		form.querySelectorAll('input[id], select[id], textarea[id]')) {
		if (!control.id || !['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tagName)) continue;
		values[control.id] =
			control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)
				? { checked: control.checked }
				: { value: control.value };
	}
	return values;
}

export function captureDirtyForms() {
	return Object.fromEntries(
		managedFormIds.filter((id) => state.dirtyForms.has(id)).map((id) => [id, formDraft(byId(id))])
	);
}

export function restoreDirtyForms(drafts) {
	for (const [formId, values] of Object.entries(drafts)) {
		for (const [id, state] of Object.entries(values)) {
			const control = byId(id);
			if (!control || (!byId(formId).contains(control) && control.form !== byId(formId))) continue;
			if ('checked' in state && control instanceof HTMLInputElement)
				control.checked = state.checked;
			else if ('value' in state) control.value = state.value;
		}
	}
}

export function setFormClean(id) {
	state.dirtyForms.delete(id);
}

export function setSkipTarget(id) {
	byId('skip-link').setAttribute('href', `#${id}`);
}

export function showView(name, options = {}) {
	if (!viewMeta[name]) return;
	if (state.currentSnapshot?.phase !== 'ready' && name !== 'provider') return;
	if (state.currentView !== name && !byId('notice').className.includes('error')) notice('');
	state.currentView = name;
	for (const panel of all('[data-view-panel]')) panel.hidden = panel.dataset.viewPanel !== name;
	for (const button of all('[data-view]')) {
		const active = button.dataset.view === name;
		button.setAttribute('aria-current', active ? 'page' : 'false');
	}
	const meta = viewMeta[name];
	setText('mobile-navigation-label', `Navigation · ${meta.title}`);
	if (window.matchMedia?.('(max-width: 700px)').matches) byId('mobile-navigation').open = false;
	setText(
		'view-kicker',
		state.currentSnapshot?.phase === 'setup_incomplete' ? 'SETUP IN PROGRESS' : meta.kicker
	);
	setText(
		'view-title',
		state.currentSnapshot?.phase === 'setup_incomplete' ? 'Connect your AI' : meta.title
	);
	setText(
		'view-description',
		state.currentSnapshot?.phase === 'setup_incomplete'
			? 'Choose a provider and verify that your agent can respond.'
			: meta.description
	);
	if (options.focus === true) byId('view-title').focus();
}

export function showClient(name, options = {}) {
	if (!['opencode', 'claude', 'mcp'].includes(name)) return;
	if (state.currentClient !== name && !byId('notice').className.includes('error')) notice('');
	state.currentClient = name;
	byId('gateway-connection').hidden = name === 'opencode';
	byId('save-client-connections').hidden = name === 'opencode';
	for (const panel of all('[data-client-panel]')) panel.hidden = panel.dataset.clientPanel !== name;
	for (const button of all('[data-client-setup]')) {
		button.setAttribute('aria-pressed', String(button.dataset.clientSetup === name));
	}
	if (options.focus === true) {
		const panel = byId(`client-${name}`);
		panel.setAttribute('tabindex', '-1');
		panel.focus();
	}
}

export function bindUiEvents() {
	const narrow = window.matchMedia?.('(max-width: 700px)');
	if (narrow) {
		const update = () => {
			byId('mobile-navigation').open = !narrow.matches;
		};
		update();
		narrow.addEventListener('change', update);
	}
	byId('dismiss-notice').addEventListener('click', () => notice(''));

	byId('refresh').addEventListener('click', () => void refresh(true));

	byId('retry-snapshot').addEventListener('click', () => {
		byId('error-state').hidden = true;
		byId('loading-state').hidden = false;
		void refresh(false);
	});

	byId('skip-link').addEventListener('click', () => {
		const id = byId('skip-link').getAttribute('href')?.slice(1);
		queueMicrotask(() => byId(id)?.focus());
	});

	for (const formId of managedFormIds) {
		for (const eventName of ['input', 'change']) {
			byId(formId).addEventListener(eventName, () => {
				if (!state.renderingSnapshot) state.dirtyForms.add(formId);
			});
		}
	}

	for (const button of all('[data-view]')) {
		button.addEventListener('click', () => showView(button.dataset.view, { focus: true }));
	}

	for (const button of all('[data-view-target]')) {
		button.addEventListener('click', () => showView(button.dataset.viewTarget, { focus: true }));
	}
	for (const button of all('[data-mapping-target]')) {
		button.addEventListener('click', () => {
			showView('access');
			byId('chat-user-access').open = true;
			byId('mapping-portal').value = button.dataset.mappingTarget;
			byId('mapping-user').focus();
		});
	}

	for (const button of all('[data-client-target]')) {
		button.addEventListener('click', () => {
			showView('connections', { focus: true });
			showClient(button.dataset.clientTarget, { focus: true });
		});
	}

	for (const button of all('[data-client-setup]')) {
		button.addEventListener('click', () => showClient(button.dataset.clientSetup, { focus: true }));
	}

	byId('load-logs').addEventListener('click', async () => {
		const logs = await operation(
			'Loading recent logs',
			() => state.api.logs(),
			'Recent logs loaded.'
		);
		if (typeof logs === 'string') byId('logs').value = logs || 'No recent log entries.';
	});
}
