const api = window.openpalmAdmin;

let currentConfig = null;
let currentSnapshot = null;
let currentView = 'overview';
let currentClient = 'opencode';
let providerSummaries = [];
let providersLoaded = false;
let providerLoadPromise;
let providerCatalogExpanded = false;
let automaticReadinessAttempted = false;
let activeOAuth = null;
let operationInFlight = false;
let disabledButtons = [];
let noticeTimer;
let importPreviewSignature = null;
let importPreviewDigest = null;
let lastReadiness = null;
let renderingSnapshot = false;

const dirtyForms = new Set();
const managedFormIds = ['connections-form', 'access-form', 'network-form'];
const commonProviders = new Set([
	'anthropic',
	'openai',
	'google',
	'github-copilot',
	'github',
	'opencode',
	'openrouter'
]);

const byId = (id) => document.getElementById(id);
const all = (selector) => [...document.querySelectorAll(selector)];
const csv = (value) =>
	value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);

const policyLabels = {
	chat: 'Conversation only',
	read: 'Read files',
	full: 'Full control'
};

const viewMeta = {
	overview: {
		kicker: 'PERSONAL AGENT',
		title: 'Your OpenPalm',
		description: 'See what is running and choose how you want to use your agent.'
	},
	provider: {
		kicker: 'AI CONNECTION',
		title: 'AI provider',
		description: 'Manage the provider OpenCode uses and verify a real response.'
	},
	connections: {
		kicker: 'CLIENTS & CHAT APPS',
		title: 'Connections',
		description: 'Choose which apps can reach your agent and how they are protected.'
	},
	access: {
		kicker: 'PEOPLE & PERMISSIONS',
		title: 'People & access',
		description: 'Give each person or app its own key and access level.'
	},
	backup: {
		kicker: 'PORTABLE RECOVERY',
		title: 'Backup',
		description: 'Protect your knowledge, workspace, preferences, and recurring work.'
	},
	diagnostics: {
		kicker: 'ADVANCED',
		title: 'Troubleshooting',
		description: 'Inspect network settings, local paths, and recent service logs.'
	}
};

function message(error) {
	return error instanceof Error ? error.message : String(error);
}

function setText(id, value) {
	byId(id).textContent = value;
}

function setBadge(element, text, tone = 'neutral') {
	element.textContent = text;
	element.className = `status-badge ${tone}`;
}

function notice(value, tone = 'success', options = {}) {
	const element = byId('notice');
	clearTimeout(noticeTimer);
	if (!value) {
		element.hidden = true;
		return;
	}
	setText('notice-message', value);
	element.className = `notice ${tone}`;
	element.hidden = false;
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
		noticeTimer = setTimeout(() => {
			element.hidden = true;
		}, 7000);
	}
}

function setBusy(value) {
	operationInFlight = value;
	document.body.dataset.busy = String(value);
	const busyRegion =
		currentSnapshot?.phase === 'not_installed' ? byId('install-section') : byId('main-content');
	busyRegion?.setAttribute('aria-busy', String(value));
	if (value) {
		disabledButtons = all('button').map((button) => ({ button, disabled: button.disabled }));
		for (const { button } of disabledButtons) button.disabled = true;
	} else {
		for (const { button, disabled } of disabledButtons) button.disabled = disabled;
		disabledButtons = [];
		if (currentSnapshot) renderRuntimeControls(currentSnapshot);
	}
}

function readinessResult(value) {
	return value && typeof value === 'object' && typeof value.ok === 'boolean';
}

async function operation(progress, action, success = `${progress} complete.`) {
	if (operationInFlight) return undefined;
	setBusy(true);
	notice(`${progress}…`, 'progress', { persist: true });
	try {
		const result = await action();
		if (readinessResult(result)) {
			lastReadiness = result;
			renderReadiness(result);
			if (!result.ok) throw new Error(result.error || 'The provider readiness check failed.');
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

function setOptions(select, values, selected) {
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

function formDraft(form) {
	const values = {};
	for (const control of form.querySelectorAll('input[id], select[id], textarea[id]')) {
		values[control.id] =
			control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)
				? { checked: control.checked }
				: { value: control.value };
	}
	return values;
}

function captureDirtyForms() {
	return Object.fromEntries(
		managedFormIds.filter((id) => dirtyForms.has(id)).map((id) => [id, formDraft(byId(id))])
	);
}

function restoreDirtyForms(drafts) {
	for (const [formId, values] of Object.entries(drafts)) {
		for (const [id, state] of Object.entries(values)) {
			const control = byId(id);
			if (!control || !byId(formId).contains(control)) continue;
			if ('checked' in state && control instanceof HTMLInputElement)
				control.checked = state.checked;
			else if ('value' in state) control.value = state.value;
		}
	}
}

function setFormClean(id) {
	dirtyForms.delete(id);
}

function dialAddress(address) {
	if (address === '0.0.0.0') return '127.0.0.1';
	if (address === '::') return '::1';
	return address;
}

function endpoint(address, port, path = '') {
	const host = dialAddress(address);
	return `http://${host.includes(':') ? `[${host}]` : host}:${port}${path}`;
}

function isRunning(service) {
	return service?.state.toLowerCase().includes('running');
}

function isHealthy(service) {
	return isRunning(service) && (!service.health || service.health.toLowerCase() === 'healthy');
}

function friendlyServiceName(name) {
	if (name === 'assistant') return 'Personal Assistant';
	if (name === 'guardian') return 'Protected access';
	if (name === 'discord') return 'Discord';
	if (name === 'slack') return 'Slack';
	return name;
}

function setSkipTarget(id) {
	byId('skip-link').setAttribute('href', `#${id}`);
}

function showView(name, options = {}) {
	if (!viewMeta[name]) return;
	if (currentSnapshot?.phase !== 'ready' && name !== 'provider') return;
	currentView = name;
	for (const panel of all('[data-view-panel]')) panel.hidden = panel.dataset.viewPanel !== name;
	for (const button of all('[data-view]')) {
		const active = button.dataset.view === name;
		button.toggleAttribute('aria-current', active);
	}
	const meta = viewMeta[name];
	setText(
		'view-kicker',
		currentSnapshot?.phase === 'setup_incomplete' ? 'SETUP IN PROGRESS' : meta.kicker
	);
	setText(
		'view-title',
		currentSnapshot?.phase === 'setup_incomplete' ? 'Connect your AI' : meta.title
	);
	setText(
		'view-description',
		currentSnapshot?.phase === 'setup_incomplete'
			? 'Choose a provider and verify that your agent can respond.'
			: meta.description
	);
	if (options.focus === true) byId('view-title').focus();
}

function showClient(name, options = {}) {
	if (!['opencode', 'claude', 'mcp'].includes(name)) return;
	currentClient = name;
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

function renderPhase(phase) {
	byId('loading-state').hidden = true;
	byId('error-state').hidden = true;
	byId('install-section').hidden = phase !== 'not_installed';
	byId('app-shell').hidden = phase === 'not_installed';
	for (const element of all('.setup-only')) element.hidden = phase !== 'setup_incomplete';
	for (const element of all('.ready-only')) element.hidden = phase !== 'ready';
	document.body.dataset.phase = phase;
	setSkipTarget(phase === 'not_installed' ? 'install-section' : 'main-content');
	if (phase === 'setup_incomplete') {
		setBadge(byId('stack-status'), 'Setup in progress', 'neutral');
		showView('provider');
	} else if (phase === 'ready') {
		showView(currentView === 'provider' && lastReadiness?.ok ? 'overview' : currentView);
	}
}

function renderRuntimeControls(snapshot) {
	const assistant = snapshot.services.find((service) => service.name === 'assistant');
	const running = isRunning(assistant);
	byId('start-stack').disabled = operationInFlight || running;
	byId('restart-stack').disabled = operationInFlight || !running;
	byId('stop-stack').disabled = operationInFlight || snapshot.services.length === 0;
}

function renderServices(snapshot) {
	const services = byId('services');
	services.replaceChildren();
	if (snapshot.services.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty-state';
		empty.textContent = snapshot.dockerError || 'OpenPalm is stopped.';
		services.append(empty);
	} else {
		for (const service of snapshot.services) {
			const row = document.createElement('div');
			row.className = 'service';
			const identity = document.createElement('div');
			identity.className = 'service-name';
			const name = document.createElement('strong');
			name.textContent = friendlyServiceName(service.name);
			const technical = document.createElement('small');
			technical.textContent = service.name;
			identity.append(name, technical);
			const status = document.createElement('span');
			const healthy = isHealthy(service);
			setBadge(
				status,
				healthy ? 'Running normally' : [service.state, service.health].filter(Boolean).join(' · '),
				healthy ? 'success' : 'neutral'
			);
			row.append(identity, status);
			services.append(row);
		}
	}
	const assistant = snapshot.services.find((service) => service.name === 'assistant');
	const guardian = snapshot.services.find((service) => service.name === 'guardian');
	setText(
		'assistant-summary',
		isHealthy(assistant) ? 'Running normally' : assistant ? 'Needs attention' : 'Stopped'
	);
	setText(
		'guardian-summary',
		snapshot.config.gateway.enabled
			? isHealthy(guardian)
				? 'Enabled and healthy'
				: 'Enabled · needs attention'
			: 'Not enabled'
	);
	const enabledPortals = ['discord', 'slack'].filter(
		(portal) => snapshot.config.portals[portal].enabled
	);
	setText(
		'portal-summary',
		enabledPortals.length
			? enabledPortals.map((portal) => portal[0].toUpperCase() + portal.slice(1)).join(' and ')
			: 'None enabled'
	);
	setBadge(
		byId('stack-status'),
		isHealthy(assistant) ? 'Agent running' : assistant ? 'Needs attention' : 'Agent stopped',
		isHealthy(assistant) ? 'success' : 'neutral'
	);
	renderRuntimeControls(snapshot);
	const needsRecovery = snapshot.phase === 'setup_incomplete' && !isHealthy(assistant);
	byId('setup-recovery').hidden = !needsRecovery;
	if (needsRecovery) {
		setText(
			'recovery-message',
			snapshot.dockerError ||
				'A port conflict or Docker problem may have interrupted the first start. Adjust the ports if needed, then retry safely.'
		);
	}
}

function credentialOptions(snapshot) {
	return Object.entries(snapshot.config.credentials)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([value, config]) => ({ value, label: `${value} — ${policyLabels[config.policy]}` }));
}

function clearClientKey(client) {
	byId(`${client}-key`).value = '';
	byId(`show-${client}-key`).checked = false;
	byId(`${client}-key`).type = 'password';
}

function updateClientPolicy(client) {
	if (!currentSnapshot) return;
	const username = byId(`${client}-credential`).value;
	const policy = currentSnapshot.config.credentials[username]?.policy;
	const help = byId(`${client}-policy-help`);
	if (!policy) {
		help.textContent = 'Choose an access identity.';
		help.className = 'help-text';
		return;
	}
	help.textContent =
		policy === 'full'
			? `${username} has Full control. Create a narrower identity unless this client is fully trusted.`
			: `${username} receives ${policyLabels[policy]} access.`;
	help.className = `help-text${policy === 'full' ? ' danger-text' : ''}`;
}

function renderCredentials(snapshot) {
	const usernames = Object.keys(snapshot.config.credentials).sort();
	const policies = byId('credential-policies');
	policies.replaceChildren();
	for (const username of usernames) {
		const row = document.createElement('div');
		row.className = 'credential-row';
		const identity = document.createElement('div');
		identity.className = 'credential-identity';
		const name = document.createElement('strong');
		name.textContent = username;
		const usage = document.createElement('small');
		const usedBy = ['discord', 'slack'].filter(
			(portal) => snapshot.config.portals[portal].credential === username
		);
		usage.textContent = usedBy.length
			? `Default for ${usedBy.join(' and ')}`
			: 'Available for MCP clients';
		identity.append(name, usage);
		const select = document.createElement('select');
		select.id = `credential-policy-${username}`;
		select.dataset.credential = username;
		select.setAttribute('aria-label', `${username} access level`);
		setOptions(
			select,
			Object.entries(policyLabels).map(([value, label]) => ({ value, label })),
			snapshot.config.credentials[username].policy
		);
		row.append(identity, select);
		policies.append(row);
	}
	for (const portal of ['discord', 'slack']) {
		setOptions(byId(`${portal}-credential`), usernames, snapshot.config.portals[portal].credential);
	}
	const actionName = byId('credential-action-name').value;
	setOptions(byId('credential-action-name'), usernames, actionName);
	byId('credential-key').value = '';
	byId('show-credential-key').checked = false;
	byId('credential-key').type = 'password';
	setOptions(
		byId('mapping-credential'),
		[
			{ value: '', label: 'Portal default (remove mapping)' },
			...usernames.map((value) => ({ value, label: value }))
		],
		byId('mapping-credential').value
	);
	const choices = credentialOptions(snapshot);
	for (const client of ['claude', 'mcp']) {
		const selected = byId(`${client}-credential`).value || 'owner';
		setOptions(byId(`${client}-credential`), choices, selected);
		clearClientKey(client);
		updateClientPolicy(client);
	}
}

function renderMappings(snapshot) {
	const container = byId('mappings');
	container.replaceChildren();
	let count = 0;
	for (const portal of ['discord', 'slack']) {
		const mappings = snapshot.portalMappings[portal]?.users || {};
		for (const [userId, username] of Object.entries(mappings)) {
			count += 1;
			const row = document.createElement('div');
			row.className = 'mapping-row';
			const identity = document.createElement('div');
			identity.className = 'mapping-identity';
			const name = document.createElement('strong');
			name.textContent = `${portal === 'discord' ? 'Discord' : 'Slack'} user ${userId}`;
			const access = document.createElement('small');
			access.textContent = `Uses ${username}`;
			identity.append(name, access);
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'danger subtle';
			remove.textContent = 'Remove override';
			remove.dataset.removeMapping = 'true';
			remove.dataset.portal = portal;
			remove.dataset.userId = userId;
			row.append(identity, remove);
			container.append(row);
		}
	}
	if (count === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty-state';
		empty.textContent = 'No individual overrides. Chat app users receive the app’s default access.';
		container.append(empty);
	}
}

function secretConfigured(snapshot, portal, name) {
	return snapshot.portalSecrets[portal]?.[name] === true;
}

function renderPortalSecrets(snapshot) {
	const discordReady = secretConfigured(snapshot, 'discord', 'discord_bot_token');
	const slackReady =
		secretConfigured(snapshot, 'slack', 'slack_bot_token') &&
		secretConfigured(snapshot, 'slack', 'slack_app_token');
	const configured = [discordReady ? 'Discord' : '', slackReady ? 'Slack' : ''].filter(Boolean);
	setBadge(
		byId('token-status'),
		configured.length ? `${configured.join(' and ')} configured` : 'Not configured',
		configured.length ? 'success' : 'neutral'
	);
}

function updateGuardianGuide() {
	if (!currentSnapshot) return;
	const saved = currentSnapshot.config.gateway.enabled;
	const selected = byId('gateway').checked;
	setText(
		'claude-guardian-help',
		saved
			? 'Protected access is enabled.'
			: selected
				? 'Protected access is selected. Save connections below to apply it.'
				: 'Protected access is currently disabled.'
	);
	const status = byId('mcp-guardian-help');
	status.className = `inline-status ${saved ? 'success' : 'neutral'}`;
	status.replaceChildren();
	const title = document.createElement('strong');
	title.textContent = saved
		? 'Guardian is enabled.'
		: selected
			? 'Guardian is ready to be saved.'
			: 'Guardian must be enabled.';
	const detail = document.createElement('span');
	detail.textContent = 'It applies the policy associated with the selected identity.';
	status.append(title, detail);
	for (const button of all('[data-enable-gateway]')) button.hidden = selected;
}

function updateConditionalConnections() {
	const guardian = byId('gateway').checked || byId('discord').checked || byId('slack').checked;
	byId('guardian-settings').hidden = !guardian;
	byId('discord-settings').hidden = !byId('discord').checked;
	byId('slack-settings').hidden = !byId('slack').checked;
	updateGuardianGuide();
}

function updatePortalTokenFields() {
	const slack = byId('token-portal').value === 'slack';
	const snapshot = currentSnapshot;
	const botConfigured = snapshot
		? secretConfigured(
				snapshot,
				slack ? 'slack' : 'discord',
				slack ? 'slack_bot_token' : 'discord_bot_token'
			)
		: false;
	const appConfigured = snapshot ? secretConfigured(snapshot, 'slack', 'slack_app_token') : false;
	setText(
		'bot-token-label',
		`${slack ? 'Slack' : 'Discord'} bot token${botConfigured ? ' (leave blank to keep current)' : ''}`
	);
	byId('app-token-field').hidden = !slack;
	byId('app-token-field').querySelector('span').textContent =
		`Slack app token${appConfigured ? ' (leave blank to keep current)' : ''}`;
	setText(
		'token-help',
		slack && botConfigured && appConfigured
			? 'Enter either token to replace only that value. Existing blank fields are kept.'
			: 'Tokens are stored in private files and are never shown again.'
	);
}

function showPortalTokenForm(portal, field = 'bot-token') {
	byId('token-portal').value = portal;
	updatePortalTokenFields();
	byId('portal-token-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
	queueMicrotask(() => byId(field).focus());
}

function renderConnectionDetails(snapshot) {
	const details = snapshot.connectionDetails;
	if (!details) return;
	setText('direct-url', details.opencode.url);
	setText('direct-username', details.opencode.username || 'opencode');
	setText('claude-url', details.claude.url);
	setText('mcp-url', details.mcp.url);
	byId('install-claude-extension').dataset.url = details.claude.extension || '';
	byId('direct-password').value = '';
	byId('direct-password').type = 'password';
	byId('show-direct-password').checked = false;
	showClient(currentClient);
	updateGuardianGuide();
}

function providerById(id) {
	return providerSummaries.find((provider) => provider.id === id);
}

function selectedProviderMethod() {
	const provider = providerById(byId('provider').value);
	const index = Number(byId('provider-method').value);
	return provider?.authMethods.find((method) => method.index === index);
}

function promptVisible(prompt, values) {
	if (!prompt.when) return true;
	const matches = values[prompt.when.key] === prompt.when.value;
	return prompt.when.op === 'eq' ? matches : !matches;
}

function updateOAuthPromptVisibility() {
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

function renderOAuthPrompts(method) {
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

function resetOAuthAttempt() {
	activeOAuth = null;
	for (const control of all('[data-oauth-key]')) control.value = '';
	byId('oauth-progress').hidden = true;
	byId('oauth-code-field').hidden = true;
	byId('oauth-code').value = '';
	byId('finish-provider-oauth').hidden = true;
}

function renderProviderMethod() {
	const provider = providerById(byId('provider').value);
	const method = selectedProviderMethod();
	byId('provider-method-field').hidden = !provider;
	byId('api-key-fields').hidden = method?.type !== 'api';
	byId('oauth-provider-note').hidden = method?.type !== 'oauth';
	if (method?.type === 'oauth') renderOAuthPrompts(method);
}

function renderProviderMethods() {
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

function renderProviderOptions() {
	const query = byId('provider-search').value.trim().toLocaleLowerCase();
	const selected = byId('provider').value;
	let visible = providerSummaries;
	if (query) {
		visible = providerSummaries.filter((provider) =>
			`${provider.name} ${provider.id}`.toLocaleLowerCase().includes(query)
		);
	} else if (!providerCatalogExpanded) {
		visible = providerSummaries.filter(
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
		providerCatalogExpanded
			? 'Show common providers'
			: `Show all ${providerSummaries.length} providers`
	);
}

function renderProviders(providers) {
	providerSummaries = providers
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
	const connected = providerSummaries.filter(
		(provider) => provider.authenticated || provider.connected
	);
	if (connected.length > 0) {
		byId('provider-status').className = 'inline-status success';
		byId('provider-status').replaceChildren();
		const title = document.createElement('strong');
		title.textContent = `${connected[0].name} sign-in found.`;
		const detail = document.createElement('span');
		detail.textContent = 'Choose “Check existing sign-in” to verify a real Assistant response.';
		byId('provider-status').append(title, detail);
		setBadge(byId('provider-badge'), 'Sign-in found', 'success');
	} else if (currentSnapshot?.phase === 'setup_incomplete') {
		byId('provider-status').className = 'inline-status neutral';
		byId('provider-status').replaceChildren();
		const title = document.createElement('strong');
		title.textContent = 'Choose the provider account you already use.';
		const detail = document.createElement('span');
		detail.textContent = 'Use an API key or OpenCode’s secure browser sign-in.';
		byId('provider-status').append(title, detail);
		setBadge(byId('provider-badge'), 'Sign-in needed', 'neutral');
	}
}

function renderReadiness(result) {
	const status = byId('provider-status');
	status.replaceChildren();
	const title = document.createElement('strong');
	const detail = document.createElement('span');
	if (result.ok) {
		const provider = providerById(result.provider);
		title.textContent = `${provider?.name || result.provider || 'Your provider'} is connected.`;
		detail.textContent = result.model
			? `OpenPalm verified a real response using ${result.model}.`
			: 'OpenPalm verified a real Assistant response.';
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

function render(snapshot, options = {}) {
	const drafts = options.preserveDirty === false ? {} : captureDirtyForms();
	const previousPhase = currentSnapshot?.phase;
	currentSnapshot = snapshot;
	currentConfig = snapshot.config;
	renderingSnapshot = true;
	byId('install-assistant-port').value = String(snapshot.config.assistant.port);
	byId('install-gateway-port').value = String(snapshot.config.gateway.port);
	byId('recovery-assistant-port').value = String(snapshot.config.assistant.port);
	byId('recovery-gateway-port').value = String(snapshot.config.gateway.port);
	renderPhase(snapshot.phase);
	if (snapshot.phase === 'not_installed') {
		renderingSnapshot = false;
		return;
	}

	setText('home', snapshot.homeDir);
	setText('config-path', snapshot.configPath);
	const assistantUrl = endpoint(
		snapshot.config.assistant.bindAddress,
		snapshot.config.assistant.port
	);
	const guardianUrl = endpoint(
		snapshot.config.gateway.bindAddress,
		snapshot.config.gateway.port,
		'/mcp'
	);
	setText('assistant-url', assistantUrl);
	setText('assistant-url-detail', assistantUrl);
	setText('guardian-url', guardianUrl);

	byId('gateway').checked = snapshot.config.gateway.enabled;
	byId('discord').checked = snapshot.config.portals.discord.enabled;
	byId('slack').checked = snapshot.config.portals.slack.enabled;
	byId('assistant-bind').value = snapshot.config.assistant.bindAddress;
	byId('assistant-port').value = String(snapshot.config.assistant.port);
	byId('gateway-bind').value = snapshot.config.gateway.bindAddress;
	byId('gateway-port').value = String(snapshot.config.gateway.port);
	const discordAccess = snapshot.config.portals.discord.access;
	const slackAccess = snapshot.config.portals.slack.access;
	byId('discord-guilds').value = discordAccess.guilds.join(',');
	byId('discord-roles').value = discordAccess.roles.join(',');
	byId('discord-users').value = discordAccess.users.join(',');
	byId('discord-blocked-users').value = discordAccess.blockedUsers.join(',');
	byId('slack-channels').value = slackAccess.channels.join(',');
	byId('slack-users').value = slackAccess.users.join(',');
	byId('slack-blocked-users').value = slackAccess.blockedUsers.join(',');

	renderServices(snapshot);
	renderCredentials(snapshot);
	renderMappings(snapshot);
	renderPortalSecrets(snapshot);
	renderConnectionDetails(snapshot);
	restoreDirtyForms(drafts);
	updateConditionalConnections();
	updatePortalTokenFields();
	renderingSnapshot = false;

	if (!lastReadiness) {
		if (snapshot.phase === 'ready') {
			byId('provider-status').className = 'inline-status success';
			byId('provider-status').replaceChildren();
			const title = document.createElement('strong');
			title.textContent = 'Provider setup is complete.';
			const detail = document.createElement('span');
			detail.textContent =
				'Run a readiness check whenever you want to verify the connection again.';
			byId('provider-status').append(title, detail);
			setBadge(byId('provider-badge'), 'Connected', 'success');
		} else {
			setBadge(byId('provider-badge'), 'Sign-in needed', 'neutral');
		}
	} else {
		renderReadiness(lastReadiness);
	}

	if (snapshot.phase === 'ready' && previousPhase === 'setup_incomplete') {
		showView('overview');
	} else if (snapshot.phase === 'ready') {
		showView(currentView);
	}

	const assistant = snapshot.services.find((service) => service.name === 'assistant');
	if (!providersLoaded && isHealthy(assistant)) queueMicrotask(() => void loadProviders(false));
}

async function showFatalError(error) {
	byId('loading-state').hidden = true;
	byId('install-section').hidden = true;
	byId('app-shell').hidden = true;
	byId('error-state').hidden = false;
	setText('error-message', message(error));
	setSkipTarget('error-state');
	try {
		setText('error-home', await api.selectedHome());
	} catch {
		setText('error-home', 'Selected OpenPalm home');
	}
	byId('error-state').focus();
}

async function refresh(announce = false) {
	try {
		const snapshot = await api.snapshot();
		render(snapshot);
		if (announce) notice('Status refreshed.', 'success');
	} catch (error) {
		if (currentSnapshot) {
			notice(`Could not refresh status: ${message(error)}`, 'error', { persist: true });
			return;
		}
		await showFatalError(error);
		notice(message(error), 'error', { persist: true });
	}
}

async function loadProviders(withNotice = true) {
	if (providersLoaded && !withNotice) return;
	const action = async () => {
		if (!providerLoadPromise) {
			providerLoadPromise = api
				.providers()
				.then((providers) => {
					providersLoaded = true;
					renderProviders(providers);
					return providers;
				})
				.finally(() => {
					providerLoadPromise = undefined;
				});
		}
		return providerLoadPromise;
	};
	if (withNotice) await operation('Finding AI providers', action, 'Provider list updated.');
	else {
		try {
			await action();
		} catch (error) {
			byId('provider-status').className = 'inline-status error';
			byId('provider-status').replaceChildren();
			const title = document.createElement('strong');
			title.textContent = 'Providers could not be loaded.';
			const detail = document.createElement('span');
			detail.textContent = message(error);
			byId('provider-status').append(title, detail);
		}
	}
	if (
		providersLoaded &&
		currentSnapshot?.phase === 'setup_incomplete' &&
		!automaticReadinessAttempted &&
		providerSummaries.some((provider) => provider.authenticated || provider.connected)
	) {
		automaticReadinessAttempted = true;
		const provider = providerSummaries.find(
			(candidate) => candidate.authenticated || candidate.connected
		);
		if (!provider) return;
		queueMicrotask(
			() =>
				void verifyProvider('Verifying your existing provider sign-in', () =>
					api.readiness({ provider: provider.id })
				)
		);
	}
}

async function verifyProvider(progress, action) {
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

function importInput(apply) {
	return {
		sourceHome: byId('import-source').value.trim(),
		apply,
		...(apply && importPreviewDigest ? { previewDigest: importPreviewDigest } : {}),
		includeProviderAuth: byId('import-auth').checked,
		includeUserEnv: byId('import-env').checked,
		includePortalMaps: byId('import-maps').checked,
		includeOAuth: byId('import-maps').checked
	};
}

function importSignature() {
	return JSON.stringify(importInput(false));
}

function invalidateImportPreview() {
	importPreviewSignature = null;
	importPreviewDigest = null;
	byId('apply-import').disabled = true;
}

function renderImportPlan(result, applied) {
	byId('data-result').value = JSON.stringify(result, null, 2);
	const summary = byId('import-summary');
	summary.replaceChildren();
	const title = document.createElement('strong');
	const detail = document.createElement('span');
	if (applied) {
		title.textContent = 'Restore applied.';
		detail.textContent = `${result.copyCount} items were restored. Review imported task definitions before enabling them.`;
		summary.className = 'inline-status success';
	} else if (result.conflicts > 0) {
		title.textContent = `Restore preview found ${result.conflicts} conflict${result.conflicts === 1 ? '' : 's'}.`;
		detail.textContent = 'Choose a fresh destination or resolve the conflicts before applying.';
		summary.className = 'inline-status error';
	} else {
		title.textContent = `${result.copyCount} item${result.copyCount === 1 ? '' : 's'} ready to restore.`;
		detail.textContent = result.warnings.length
			? `${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'} need review.`
			: 'No conflicts or warnings were found.';
		summary.className = 'inline-status success';
	}
	summary.append(title, detail);
}

async function saveConfigAndApply(config, formId, action, progress, success) {
	return operation(
		progress,
		async () => {
			const saved = await api.saveConfig(config);
			setFormClean(formId);
			render(saved);
			return api.action(action);
		},
		success
	);
}

async function chooseDirectory(purpose, inputId) {
	try {
		const selected = await api.chooseDirectory({ purpose });
		if (!selected) return;
		byId(inputId).value = selected;
		byId(inputId).dispatchEvent(new Event('input', { bubbles: true }));
		byId(inputId).focus();
	} catch (error) {
		notice(message(error), 'error', { persist: true });
	}
}

async function loadDirectPassword(copyOnly) {
	const verb = copyOnly ? 'copy' : 'reveal';
	if (
		!window.confirm(
			`${verb === 'copy' ? 'Copy' : 'Reveal'} the trusted OpenCode password? It provides full local access.`
		)
	)
		return;
	const result = await operation(
		`${copyOnly ? 'Copying' : 'Loading'} OpenCode password`,
		async () => {
			const value = await api.assistantPassword();
			if (copyOnly) await api.copyText(value.password);
			return value;
		},
		copyOnly ? 'OpenCode password copied.' : 'OpenCode password loaded and kept masked.'
	);
	if (result && !copyOnly) byId('direct-password').value = result.password;
}

async function loadClientKey(client, copyOnly) {
	const username = byId(`${client}-credential`).value;
	if (!username) return;
	if (
		!window.confirm(
			`${copyOnly ? 'Copy' : 'Reveal'} the key for ${username}? Its policy controls what this client can do.`
		)
	)
		return;
	const result = await operation(
		`${copyOnly ? 'Copying' : 'Loading'} access key`,
		async () => {
			const value = await api.credentialKey(username);
			if (copyOnly) await api.copyText(value.key);
			return value;
		},
		copyOnly ? `Key for ${username} copied.` : `Key for ${username} loaded and kept masked.`
	);
	if (result && !copyOnly) byId(`${client}-key`).value = result.key;
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
			if (!renderingSnapshot) dirtyForms.add(formId);
		});
	}
}

for (const button of all('[data-view]')) {
	button.addEventListener('click', () => showView(button.dataset.view, { focus: true }));
}
for (const button of all('[data-view-target]')) {
	button.addEventListener('click', () => showView(button.dataset.viewTarget, { focus: true }));
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

byId('install-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	if (!currentConfig) return;
	const assistantPort = Number(byId('install-assistant-port').value);
	const gatewayPort = Number(byId('install-gateway-port').value);
	if (assistantPort === gatewayPort) {
		notice('The Assistant and protected-access ports must be different.', 'error', {
			persist: true
		});
		byId('install-gateway-port').focus();
		return;
	}
	const config = structuredClone(currentConfig);
	config.assistant.port = assistantPort;
	config.gateway.port = gatewayPort;
	const result = await operation(
		'Setting up OpenPalm',
		() => api.install(config),
		'OpenPalm is installed. Next, connect your AI provider.'
	);
	if (!result) await refresh(false);
});

byId('recovery-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	if (!currentConfig) return;
	const assistantPort = Number(byId('recovery-assistant-port').value);
	const gatewayPort = Number(byId('recovery-gateway-port').value);
	if (assistantPort === gatewayPort) {
		notice('The Assistant and protected-access ports must be different.', 'error', {
			persist: true
		});
		byId('recovery-gateway-port').focus();
		return;
	}
	const config = structuredClone(currentConfig);
	config.assistant.port = assistantPort;
	config.gateway.port = gatewayPort;
	await operation(
		'Retrying OpenPalm startup',
		async () => {
			const saved = await api.saveConfig(config);
			render(saved);
			return api.action('start');
		},
		'OpenPalm started. Now connect your AI provider.'
	);
});

all('[data-action]').forEach((button) => {
	button.addEventListener('click', () => {
		const action = button.dataset.action;
		const labels = {
			start: ['Starting OpenPalm', 'OpenPalm started.'],
			restart: ['Restarting OpenPalm', 'OpenPalm restarted.'],
			stop: ['Stopping OpenPalm', 'OpenPalm stopped. Your data is unchanged.']
		};
		void operation(labels[action][0], () => api.action(action), labels[action][1]);
	});
});

for (const id of ['gateway', 'discord', 'slack']) {
	byId(id).addEventListener('change', updateConditionalConnections);
}
for (const button of all('[data-enable-gateway]')) {
	button.addEventListener('click', () => {
		byId('gateway').checked = true;
		dirtyForms.add('connections-form');
		updateConditionalConnections();
		byId('connections-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
		notice('Protected access selected. Review and save Connections to apply it.', 'progress', {
			persist: true
		});
	});
}

byId('connections-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	if (!currentConfig || !currentSnapshot) return;
	const discord = byId('discord').checked;
	const slack = byId('slack').checked;
	const discordAccess = {
		guilds: csv(byId('discord-guilds').value),
		roles: csv(byId('discord-roles').value),
		users: csv(byId('discord-users').value),
		blockedUsers: csv(byId('discord-blocked-users').value)
	};
	const slackAccess = {
		channels: csv(byId('slack-channels').value),
		users: csv(byId('slack-users').value),
		blockedUsers: csv(byId('slack-blocked-users').value)
	};
	if (
		discord &&
		discordAccess.guilds.length + discordAccess.roles.length + discordAccess.users.length === 0
	) {
		notice(
			'Add at least one allowed Discord server, role, or user before enabling Discord.',
			'error',
			{ persist: true }
		);
		byId('discord-access-disclosure').open = true;
		queueMicrotask(() => byId('discord-users').focus());
		return;
	}
	if (slack && slackAccess.channels.length + slackAccess.users.length === 0) {
		notice('Add at least one allowed Slack channel or user before enabling Slack.', 'error', {
			persist: true
		});
		byId('slack-access-disclosure').open = true;
		queueMicrotask(() => byId('slack-users').focus());
		return;
	}
	if (discord && !secretConfigured(currentSnapshot, 'discord', 'discord_bot_token')) {
		notice('Store a Discord bot token before enabling Discord.', 'error', { persist: true });
		showPortalTokenForm('discord');
		return;
	}
	if (
		slack &&
		(!secretConfigured(currentSnapshot, 'slack', 'slack_bot_token') ||
			!secretConfigured(currentSnapshot, 'slack', 'slack_app_token'))
	) {
		notice('Store both Slack tokens before enabling Slack.', 'error', { persist: true });
		showPortalTokenForm(
			'slack',
			secretConfigured(currentSnapshot, 'slack', 'slack_bot_token') ? 'app-token' : 'bot-token'
		);
		return;
	}
	const config = structuredClone(currentConfig);
	config.gateway.enabled = byId('gateway').checked || discord || slack;
	config.portals.discord = {
		enabled: discord,
		credential: byId('discord-credential').value,
		access: discordAccess
	};
	config.portals.slack = {
		enabled: slack,
		credential: byId('slack-credential').value,
		access: slackAccess
	};
	await saveConfigAndApply(
		config,
		'connections-form',
		'start',
		'Saving connections',
		'Connections saved and OpenPalm is running.'
	);
});

byId('access-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	if (!currentConfig) return;
	const config = structuredClone(currentConfig);
	const escalated = [];
	for (const select of all('[data-credential]')) {
		if (
			config.credentials[select.dataset.credential].policy !== 'full' &&
			select.value === 'full'
		) {
			escalated.push(select.dataset.credential);
		}
		config.credentials[select.dataset.credential].policy = select.value;
	}
	if (
		escalated.length > 0 &&
		!window.confirm(
			`Give ${escalated.join(', ')} Full control? These keys will inherit the Assistant's permissions.`
		)
	)
		return;
	await saveConfigAndApply(
		config,
		'access-form',
		'restart',
		'Saving access levels',
		'Access levels saved and applied.'
	);
});

byId('network-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	if (!currentConfig) return;
	const assistantBind = byId('assistant-bind').value.trim();
	const assistantPort = Number(byId('assistant-port').value);
	const gatewayPort = Number(byId('gateway-port').value);
	if (assistantPort === gatewayPort) {
		notice('The Assistant and protected-access ports must be different.', 'error', {
			persist: true
		});
		byId('gateway-port').focus();
		return;
	}
	const loopback = assistantBind === '::1' || assistantBind.startsWith('127.');
	if (
		!loopback &&
		!window.confirm(
			'Direct OpenCode access bypasses Guardian. Continue only on a trusted network with TLS.'
		)
	)
		return;
	const config = structuredClone(currentConfig);
	config.assistant = { bindAddress: assistantBind, port: assistantPort };
	config.gateway = {
		...config.gateway,
		bindAddress: byId('gateway-bind').value.trim(),
		port: gatewayPort
	};
	await saveConfigAndApply(
		config,
		'network-form',
		'restart',
		'Saving network settings',
		'Network settings saved and OpenPalm restarted.'
	);
});

byId('load-providers').addEventListener('click', () => void loadProviders(true));
byId('provider-search').addEventListener('input', renderProviderOptions);
byId('show-all-providers').addEventListener('click', () => {
	providerCatalogExpanded = !providerCatalogExpanded;
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
			return api.readiness(provider ? { provider } : undefined);
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
		api.providerKey({ provider, key })
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
		() => api.providerOAuthStart({ provider, method: method.index, inputs }),
		'Provider sign-in opened in your browser.'
	);
	if (!result) return;
	activeOAuth = { provider, method: method.index, mode: result.method };
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
	if (!activeOAuth) return;
	const code = byId('oauth-code').value.trim();
	if (activeOAuth.mode === 'code' && !code) {
		notice('Paste the authorization code from your provider.', 'error', { persist: true });
		byId('oauth-code').focus();
		return;
	}
	const verified = await verifyProvider('Completing provider sign-in and checking readiness', () =>
		api.providerOAuthFinish({
			provider: activeOAuth.provider,
			method: activeOAuth.method,
			...(code ? { code } : {})
		})
	);
	if (verified) resetOAuthAttempt();
});

for (const button of all('[data-copy-field]')) {
	button.addEventListener('click', async () => {
		const value = byId(button.dataset.copyField).textContent;
		await operation('Copying connection value', () => api.copyText(value), 'Copied.');
	});
}
byId('load-direct-password').addEventListener('click', () => void loadDirectPassword(false));
byId('copy-direct-password').addEventListener('click', () => void loadDirectPassword(true));
byId('show-direct-password').addEventListener('change', () => {
	byId('direct-password').type = byId('show-direct-password').checked ? 'text' : 'password';
});
for (const client of ['claude', 'mcp']) {
	byId(`${client}-credential`).addEventListener('change', () => clearClientKey(client));
	byId(`${client}-credential`).addEventListener('change', () => updateClientPolicy(client));
	byId(`show-${client}-key`).addEventListener('change', () => {
		byId(`${client}-key`).type = byId(`show-${client}-key`).checked ? 'text' : 'password';
	});
}
for (const button of all('[data-load-client-key]')) {
	button.addEventListener('click', () => void loadClientKey(button.dataset.loadClientKey, false));
}
for (const button of all('[data-copy-client-key]')) {
	button.addEventListener('click', () => void loadClientKey(button.dataset.copyClientKey, true));
}
byId('install-claude-extension').addEventListener('click', async () => {
	const url = byId('install-claude-extension').dataset.url;
	if (!url) return;
	await operation(
		'Opening extension download',
		() => api.openExternal(url),
		'Extension download opened.'
	);
});
for (const button of all('[data-external-url]')) {
	button.addEventListener(
		'click',
		() =>
			void operation(
				'Opening setup page',
				() => api.openExternal(button.dataset.externalUrl),
				'Setup page opened.'
			)
	);
}
for (const button of all('[data-token-target]')) {
	button.addEventListener('click', () => showPortalTokenForm(button.dataset.tokenTarget));
}

byId('credential-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const policy = byId('credential-policy').value;
	if (
		policy === 'full' &&
		!window.confirm('Create a Full control key? It will inherit the Assistant’s permissions.')
	)
		return;
	const username = byId('credential-username').value.trim();
	const result = await operation(
		'Creating access key',
		() => api.credential({ action: 'create', username, policy }),
		`Access for ${username} created. Reveal the key when you are ready to connect it.`
	);
	if (result) {
		byId('credential-username').value = '';
		byId('credential-action-name').value = username;
	}
});

byId('rotate-credential').addEventListener('click', () => {
	const username = byId('credential-action-name').value;
	if (!username) return;
	if (
		window.confirm(
			`Rotate the key for ${username}? Every client using the current key will disconnect immediately.`
		)
	) {
		void operation(
			'Rotating access key',
			() => api.credential({ action: 'rotate', username }),
			`Key for ${username} rotated. Update every client that uses it.`
		);
	}
});

byId('remove-credential').addEventListener('click', () => {
	const username = byId('credential-action-name').value;
	if (username && window.confirm(`Remove access for ${username} and revoke its key?`)) {
		void operation(
			'Removing access',
			() => api.credential({ action: 'remove', username }),
			`Access for ${username} removed.`
		);
	}
});

byId('reveal-credential').addEventListener('click', async () => {
	const username = byId('credential-action-name').value;
	if (!username) return;
	if (!window.confirm('Reveal this access key? Anyone with it receives the selected access level.'))
		return;
	const result = await operation(
		'Loading access key',
		() => api.credentialKey(username),
		'Access key loaded and kept masked.'
	);
	if (result) byId('credential-key').value = result.key;
});

byId('show-credential-key').addEventListener('change', () => {
	byId('credential-key').type = byId('show-credential-key').checked ? 'text' : 'password';
});
byId('credential-action-name').addEventListener('change', () => {
	byId('credential-key').value = '';
	byId('show-credential-key').checked = false;
	byId('credential-key').type = 'password';
});

byId('mapping-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const portal = byId('mapping-portal').value;
	const userId = byId('mapping-user').value.trim();
	const username = byId('mapping-credential').value || undefined;
	const result = await operation(
		'Saving chat app user access',
		() => api.mapPortalUser({ portal, userId, username }),
		username ? 'Individual user access saved.' : 'Individual override removed.'
	);
	if (result) byId('mapping-user').value = '';
});

byId('mappings').addEventListener('click', (event) => {
	const button = event.target.closest('[data-remove-mapping]');
	if (!button) return;
	if (
		window.confirm(`Remove the ${button.dataset.portal} override for ${button.dataset.userId}?`)
	) {
		void operation(
			'Removing user override',
			() =>
				api.mapPortalUser({
					portal: button.dataset.portal,
					userId: button.dataset.userId
				}),
			'Individual user override removed.'
		);
	}
});

byId('token-portal').addEventListener('change', updatePortalTokenFields);
byId('portal-token-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const portal = byId('token-portal').value;
	const botToken = byId('bot-token').value;
	const appToken = byId('app-token').value;
	const botConfigured = secretConfigured(
		currentSnapshot,
		portal,
		portal === 'slack' ? 'slack_bot_token' : 'discord_bot_token'
	);
	const appConfigured =
		portal === 'slack' && secretConfigured(currentSnapshot, 'slack', 'slack_app_token');
	if (portal === 'discord' && !botToken) {
		notice('Enter the Discord bot token.', 'error', { persist: true });
		return;
	}
	if (portal === 'slack' && ((!botConfigured && !botToken) || (!appConfigured && !appToken))) {
		notice('Enter both Slack tokens the first time.', 'error', { persist: true });
		return;
	}
	if (portal === 'slack' && !botToken && !appToken) {
		notice('Enter at least one Slack token to replace.', 'error', { persist: true });
		return;
	}
	const result = await operation(
		`Storing ${portal === 'slack' ? 'Slack' : 'Discord'} tokens`,
		() =>
			api.portalToken({ portal, botToken, appToken: portal === 'slack' ? appToken : undefined }),
		`${portal === 'slack' ? 'Slack' : 'Discord'} tokens stored privately.`
	);
	if (result) {
		byId('bot-token').value = '';
		byId('app-token').value = '';
	}
});

byId('choose-backup-destination').addEventListener(
	'click',
	() => void chooseDirectory('backup', 'backup-destination')
);
byId('choose-import-source').addEventListener(
	'click',
	() => void chooseDirectory('restore', 'import-source')
);
byId('backup-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const destination = byId('backup-destination').value.trim();
	const result = await operation(
		'Creating backup',
		() =>
			api.backup({
				destination,
				includeProviderAuth: byId('backup-auth').checked,
				includeUserEnv: byId('backup-env').checked,
				includePortalMaps: byId('backup-maps').checked,
				includeOAuth: byId('backup-maps').checked
			}),
		'Backup created successfully.'
	);
	if (!result) return;
	byId('backup-result').value = JSON.stringify(result, null, 2);
	byId('backup-summary').className = 'inline-status success';
	byId('backup-summary').replaceChildren();
	const title = document.createElement('strong');
	title.textContent = `${result.files.length} file${result.files.length === 1 ? '' : 's'} backed up.`;
	const detail = document.createElement('span');
	detail.textContent = result.warnings.length
		? `Backup completed with ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}.`
		: `Saved to ${destination}.`;
	byId('backup-summary').append(title, detail);
});

for (const eventName of ['input', 'change']) {
	byId('import-form').addEventListener(eventName, invalidateImportPreview);
}
byId('preview-import').addEventListener('click', async () => {
	const signature = importSignature();
	const result = await operation(
		'Previewing restore',
		() => api.importData(importInput(false)),
		'Restore preview is ready for review.'
	);
	if (!result) return;
	renderImportPlan(result, false);
	importPreviewSignature = signature;
	importPreviewDigest = result.digest;
	byId('apply-import').disabled = result.conflicts > 0;
});
byId('apply-import').addEventListener('click', async () => {
	if (importPreviewSignature !== importSignature() || !importPreviewDigest) {
		notice('Preview these restore choices again before applying them.', 'error', { persist: true });
		invalidateImportPreview();
		return;
	}
	if (!window.confirm('Apply this reviewed restore plan to the fresh OpenPalm installation?'))
		return;
	const result = await operation(
		'Applying restore',
		() => api.importData(importInput(true)),
		'Restore applied. Your imported data is ready for review.'
	);
	if (result) {
		renderImportPlan(result, true);
		providersLoaded = false;
		await loadProviders(false);
		invalidateImportPreview();
	}
});

byId('load-logs').addEventListener('click', async () => {
	const logs = await operation('Loading recent logs', () => api.logs(), 'Recent logs loaded.');
	if (typeof logs === 'string') byId('logs').value = logs || 'No recent log entries.';
});

void refresh(false);
