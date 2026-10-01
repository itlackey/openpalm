import { promptVisible } from './model.js';
import { refresh } from './snapshot.js';
import { commonProviders, state } from './state.js';
import {
	all,
	byId,
	message,
	notice,
	operation,
	setBadge,
	setOptions,
	setText,
	showView
} from './ui.js';

export function providerById(id) {
	return state.providerSummaries.find((provider) => provider.id === id);
}

export function selectedProviderMethod() {
	const provider = providerById(byId('provider').value);
	const index = Number(byId('provider-method').value);
	return provider?.authMethods.find((method) => method.index === index);
}

export function updateOAuthPromptVisibility() {
	const method = selectedProviderMethod();
	if (!method?.prompts) return;
	const values = Object.fromEntries(
		all('[data-oauth-key]').map((control) => [control.dataset.oauthKey, control.value])
	);
	for (const [index, prompt] of method.prompts.entries()) {
		const field = byId(`oauth-prompt-${index}`);
		const visible = promptVisible(prompt, values);
		field.hidden = !visible;
		const control = field.querySelector('[data-oauth-key]');
		control.disabled = !visible;
		control.required = visible;
	}
}

export function renderOAuthPrompts(method) {
	const container = byId('oauth-prompt-fields');
	container.replaceChildren();
	for (const [index, prompt] of (method?.prompts || []).entries()) {
		const label = document.createElement('label');
		label.className = 'field';
		label.id = `oauth-prompt-${index}`;
		const caption = document.createElement('span');
		caption.textContent = prompt.message;
		const control = document.createElement(prompt.type === 'select' ? 'select' : 'input');
		control.id = `oauth-input-${index}`;
		control.dataset.oauthKey = prompt.key;
		if (prompt.type === 'select') {
			setOptions(control, [
				{ value: '', label: 'Choose one' },
				...prompt.options.map((option) => ({
					value: option.value,
					label: option.hint ? `${option.label} — ${option.hint}` : option.label
				}))
			]);
		} else {
			control.type = /key|secret|token|password/i.test(`${prompt.key} ${prompt.message}`)
				? 'password'
				: 'text';
			control.autocomplete = 'off';
			control.placeholder = prompt.placeholder || '';
		}
		control.addEventListener('input', updateOAuthPromptVisibility);
		control.addEventListener('change', updateOAuthPromptVisibility);
		label.append(caption, control);
		container.append(label);
	}
	updateOAuthPromptVisibility();
}

export function resetOAuthAttempt() {
	state.activeOAuth = null;
	for (const control of all('[data-oauth-key]')) control.value = '';
	byId('oauth-progress').hidden = true;
	byId('oauth-code-field').hidden = true;
	byId('oauth-code').value = '';
	byId('finish-provider-oauth').hidden = true;
}

export function renderProviderMethod() {
	const provider = providerById(byId('provider').value);
	const method = selectedProviderMethod();
	byId('test-provider').hidden = !provider && state.currentSnapshot?.phase !== 'ready';
	byId('provider-method-field').hidden = !provider || provider.authMethods.length < 2;
	byId('api-key-fields').hidden = method?.type !== 'api';
	byId('api-key-fields').open = !(provider?.authenticated || provider?.connected);
	byId('oauth-provider-note').hidden = method?.type !== 'oauth';
	if (method?.type === 'oauth') renderOAuthPrompts(method);
}

export function renderProviderMethods() {
	resetOAuthAttempt();
	const provider = providerById(byId('provider').value);
	const methods = provider?.authMethods || [];
	setOptions(
		byId('provider-method'),
		methods.length
			? [
					{ value: '', label: 'Choose a sign-in method' },
					...methods.map((method) => ({ value: String(method.index), label: method.label }))
				]
			: [{ value: '', label: 'No sign-in method available' }]
	);
	if (methods.length === 1) byId('provider-method').value = String(methods[0].index);
	renderProviderMethod();
}

export function renderProviderOptions() {
	const query = byId('provider-search').value.trim().toLocaleLowerCase();
	const selected =
		byId('provider').value ||
		state.providerSummaries.find((provider) => provider.authenticated || provider.connected)?.id ||
		'';
	let visible = state.providerSummaries;
	if (query) {
		visible = state.providerSummaries.filter((provider) =>
			`${provider.name} ${provider.id}`.toLocaleLowerCase().includes(query)
		);
	} else if (!state.providerCatalogExpanded) {
		visible = state.providerSummaries.filter(
			(provider) => provider.authenticated || provider.connected || commonProviders.has(provider.id)
		);
	}
	if (selected && !visible.some((provider) => provider.id === selected)) {
		const selectedProvider = providerById(selected);
		if (selectedProvider) visible = [selectedProvider, ...visible];
	}
	setOptions(
		byId('provider'),
		[
			{ value: '', label: visible.length ? 'Choose a provider' : 'No matching providers' },
			...visible.map((provider) => ({
				value: provider.id,
				label: `${provider.name}${provider.authenticated || provider.connected ? ' — connected' : ''}`
			}))
		],
		selected
	);
	setText(
		'show-all-providers',
		state.providerCatalogExpanded
			? 'Show common providers'
			: `Show all ${state.providerSummaries.length} providers`
	);
}

export function renderProviders(providers) {
	state.providerSummaries = providers
		.filter(
			(provider) => provider.authMethods.length > 0 || provider.authenticated || provider.connected
		)
		.sort((left, right) => {
			const leftReady = Number(left.authenticated || left.connected);
			const rightReady = Number(right.authenticated || right.connected);
			const leftCommon = Number(commonProviders.has(left.id));
			const rightCommon = Number(commonProviders.has(right.id));
			return (
				rightReady - leftReady || rightCommon - leftCommon || left.name.localeCompare(right.name)
			);
		});
	renderProviderOptions();
	renderProviderMethods();
	byId('provider-result').value = JSON.stringify(providers, null, 2);
	const connected = state.providerSummaries.filter(
		(provider) => provider.authenticated || provider.connected
	);
	if (connected.length > 0) {
		byId('provider-status').className = 'inline-status success';
		byId('provider-status').replaceChildren();
		const title = document.createElement('strong');
		title.textContent = `${connected[0].name} sign-in found.`;
		const detail = document.createElement('span');
		detail.textContent = 'Choose “Verify connection” to check a real agent response.';
		byId('provider-status').append(title, detail);
		setBadge(byId('provider-badge'), 'Sign-in found', 'success');
	} else if (state.currentSnapshot?.phase === 'setup_incomplete') {
		byId('provider-status').className = 'inline-status neutral';
		byId('provider-status').replaceChildren();
		const title = document.createElement('strong');
		title.textContent = 'Choose the provider account you already use.';
		byId('provider-status').append(title);
		setBadge(byId('provider-badge'), 'Sign-in needed', 'neutral');
	}
}

export function renderReadiness(result) {
	const status = byId('provider-status');
	status.setAttribute('role', result.ok ? 'status' : 'alert');
	status.setAttribute('aria-live', result.ok ? 'polite' : 'assertive');
	status.replaceChildren();
	const title = document.createElement('strong');
	const detail = document.createElement('span');
	if (result.ok) {
		const provider = providerById(result.provider);
		title.textContent = `${provider?.name || result.provider || 'Your provider'} is connected.`;
		detail.textContent = 'OpenPalm verified a real agent response.';
		status.className = 'inline-status success';
		setBadge(byId('provider-badge'), 'Connected', 'success');
	} else {
		title.textContent = 'OpenPalm could not verify this provider.';
		detail.textContent = result.error || 'Check the sign-in or API key and try again.';
		status.className = 'inline-status error';
		setBadge(byId('provider-badge'), 'Needs attention', 'error');
	}
	status.append(title, detail);
	byId('provider-result').value = JSON.stringify(result, null, 2);
}

export async function loadProviders(withNotice = true) {
	if (state.providersLoaded && !withNotice) return;
	const action = async () => {
		if (!state.providerLoadPromise) {
			state.providerLoadPromise = state.api
				.providers()
				.then((providers) => {
					state.providersLoaded = true;
					renderProviders(providers);
					return providers;
				})
				.catch((error) => {
					byId('provider-result').value = JSON.stringify({ error: message(error) }, null, 2);
					byId('provider-status').className = 'inline-status error';
					byId('provider-status').replaceChildren();
					const title = document.createElement('strong');
					title.textContent = 'Cannot reach your agent.';
					const detail = document.createElement('span');
					detail.textContent =
						'Check that it is running, then choose Refresh accounts. Technical details are available below.';
					byId('provider-status').append(title, detail);
					throw new Error(
						'Cannot reach your agent. Check that it is running, then refresh accounts.'
					);
				})
				.finally(() => {
					state.providerLoadPromise = undefined;
				});
		}
		return state.providerLoadPromise;
	};
	if (withNotice) await operation('Finding AI providers', action, 'Provider list updated.');
	else {
		try {
			await action();
		} catch {
			// The shared loader already renders the actionable error and technical details.
		}
	}
	if (
		state.providersLoaded &&
		state.currentSnapshot?.phase === 'setup_incomplete' &&
		!state.automaticReadinessAttempted &&
		state.providerSummaries.some((provider) => provider.authenticated || provider.connected)
	) {
		state.automaticReadinessAttempted = true;
		const provider = state.providerSummaries.find(
			(candidate) => candidate.authenticated || candidate.connected
		);
		if (!provider) return;
		queueMicrotask(
			() =>
				void verifyProvider('Verifying your existing provider sign-in', () =>
					state.api.readiness({ provider: provider.id })
				)
		);
	}
}

export async function verifyProvider(progress, action) {
	const result = await operation(
		progress,
		action,
		'Provider verified. Your personal agent is ready.'
	);
	if (!result?.ok) return false;
	await refresh(false);
	showView('overview');
	return true;
}

export function bindProvidersEvents() {
	byId('load-providers').addEventListener('click', () => void loadProviders(true));

	byId('provider-search').addEventListener('input', renderProviderOptions);

	byId('show-all-providers').addEventListener('click', () => {
		state.providerCatalogExpanded = !state.providerCatalogExpanded;
		renderProviderOptions();
	});

	byId('provider').addEventListener('change', renderProviderMethods);

	byId('provider-method').addEventListener('change', () => {
		resetOAuthAttempt();
		renderProviderMethod();
	});

	byId('test-provider').addEventListener(
		'click',
		() =>
			void verifyProvider('Checking provider readiness', () => {
				const provider = byId('provider').value;
				return state.api.readiness(provider ? { provider } : undefined);
			})
	);

	byId('provider-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		const provider = byId('provider').value;
		const method = selectedProviderMethod();
		const key = byId('provider-key').value;
		if (!provider) {
			notice('Choose an AI provider first.', 'error', { persist: true });
			byId('provider').focus();
			return;
		}
		if (method?.type !== 'api') {
			notice('Choose an API key sign-in method first.', 'error', { persist: true });
			byId('provider-method').focus();
			return;
		}
		if (!key) {
			notice('Enter the provider API key.', 'error', { persist: true });
			byId('provider-key').focus();
			return;
		}
		await verifyProvider('Saving the provider key and checking readiness', () =>
			state.api.providerKey({ provider, key })
		);
		byId('provider-key').value = '';
	});

	byId('start-provider-oauth').addEventListener('click', async () => {
		const provider = byId('provider').value;
		const method = selectedProviderMethod();
		if (!provider || method?.type !== 'oauth') {
			notice('Choose a browser sign-in method first.', 'error', { persist: true });
			return;
		}
		const inputs = {};
		for (const control of all('[data-oauth-key]:not(:disabled)')) {
			if (!control.value) {
				notice(
					`Complete “${control.closest('.field').querySelector('span').textContent}” first.`,
					'error',
					{ persist: true }
				);
				control.focus();
				return;
			}
			inputs[control.dataset.oauthKey] = control.value;
		}
		const result = await operation(
			'Opening provider sign-in',
			() => state.api.providerOAuthStart({ provider, method: method.index, inputs }),
			'Provider sign-in opened in your browser.'
		);
		if (!result) return;
		state.activeOAuth = { provider, method: method.index, mode: result.method };
		byId('oauth-progress').hidden = false;
		setText(
			'oauth-instructions',
			result.instructions || 'Return here when the provider says you are connected.'
		);
		byId('oauth-code-field').hidden = result.method !== 'code';
		byId('finish-provider-oauth').hidden = false;
		if (result.method === 'code') byId('oauth-code').focus();
	});

	byId('finish-provider-oauth').addEventListener('click', async () => {
		if (!state.activeOAuth) return;
		const code = byId('oauth-code').value.trim();
		if (state.activeOAuth.mode === 'code' && !code) {
			notice('Paste the authorization code from your provider.', 'error', { persist: true });
			byId('oauth-code').focus();
			return;
		}
		const verified = await verifyProvider(
			'Completing provider sign-in and checking readiness',
			() =>
				state.api.providerOAuthFinish({
					provider: state.activeOAuth.provider,
					method: state.activeOAuth.method,
					...(code ? { code } : {})
				})
		);
		if (verified) resetOAuthAttempt();
	});
}
