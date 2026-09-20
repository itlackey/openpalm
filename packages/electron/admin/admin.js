const api = window.openpalmAdmin;
let currentConfig = null;

const byId = (id) => document.getElementById(id);
const csv = (value) =>
	value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);

function notice(message, error = false) {
	const element = byId('notice');
	element.textContent = message;
	element.classList.toggle('error', error);
}

function options(select, values, selected) {
	select.replaceChildren();
	for (const value of values) {
		const option = document.createElement('option');
		option.value = value;
		option.textContent = value;
		select.append(option);
	}
	if (selected) select.value = selected;
}

function render(snapshot) {
	currentConfig = snapshot.config;
	byId('home').textContent = `${snapshot.homeDir} · ${snapshot.configPath}`;
	byId('install-section').hidden = snapshot.installed;
	document.querySelectorAll('.installed-only').forEach((element) => {
		element.hidden = !snapshot.installed;
	});
	byId('install-assistant-port').value = String(snapshot.config.assistant.port);
	byId('install-gateway-port').value = String(snapshot.config.gateway.port);
	if (!snapshot.installed) return;

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

	const policies = byId('credential-policies');
	policies.replaceChildren();
	const usernames = Object.keys(snapshot.config.credentials).sort();
	for (const username of usernames) {
		const label = document.createElement('label');
		label.append(`${username} policy `);
		const select = document.createElement('select');
		select.dataset.credential = username;
		options(select, ['chat', 'read', 'full'], snapshot.config.credentials[username].policy);
		label.append(select);
		policies.append(label);
	}
	for (const portal of ['discord', 'slack']) {
		options(byId(`${portal}-credential`), usernames, snapshot.config.portals[portal].credential);
	}
	options(byId('credential-action-name'), usernames);
	byId('credential-key').value = '';
	byId('show-credential-key').checked = false;
	byId('credential-key').type = 'password';
	options(byId('mapping-credential'), ['', ...usernames]);
	byId('mapping-credential').options[0].textContent = 'Portal default (remove mapping)';
	byId('mappings').textContent = JSON.stringify(snapshot.portalMappings, null, 2);
	byId('token-status').textContent =
		`Configured secrets: ${JSON.stringify(snapshot.portalSecrets)}`;

	const services = byId('services');
	services.replaceChildren();
	if (snapshot.services.length === 0)
		services.textContent = snapshot.dockerError || 'No containers are running.';
	for (const service of snapshot.services) {
		const row = document.createElement('div');
		row.className = 'service';
		const name = document.createElement('strong');
		name.textContent = service.name;
		const status = document.createElement('span');
		status.textContent = [service.state, service.health].filter(Boolean).join(' · ');
		row.append(name, status);
		services.append(row);
	}
}

async function refresh() {
	try {
		render(await api.snapshot());
		notice('');
	} catch (error) {
		notice(error.message || String(error), true);
	}
}

async function operation(message, action) {
	notice(`${message}…`);
	try {
		const result = await action();
		if (result?.config) render(result);
		notice(`${message} completed.`);
		return result;
	} catch (error) {
		notice(error.message || String(error), true);
	}
}

byId('refresh').addEventListener('click', refresh);
byId('install-form').addEventListener('submit', (event) => {
	event.preventDefault();
	if (!currentConfig) return;
	const assistantPort = Number(byId('install-assistant-port').value);
	const gatewayPort = Number(byId('install-gateway-port').value);
	if (assistantPort === gatewayPort) {
		notice('Assistant and Guardian ports must be different.', true);
		return;
	}
	const config = structuredClone(currentConfig);
	config.assistant.port = assistantPort;
	config.gateway.port = gatewayPort;
	void operation('Installing OpenPalm', () => api.install(config));
});
document.querySelectorAll('[data-action]').forEach((button) => {
	button.addEventListener('click', () =>
		operation(`Stack ${button.dataset.action}`, () => api.action(button.dataset.action))
	);
});

byId('config-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const discord = byId('discord').checked;
	const slack = byId('slack').checked;
	const assistantBind = byId('assistant-bind').value.trim();
	const loopback = assistantBind === '::1' || assistantBind.startsWith('127.');
	if (
		!loopback &&
		!window.confirm(
			'Direct OpenCode access bypasses Guardian. Continue only on a trusted network with TLS.'
		)
	)
		return;
	if (!currentConfig) return;
	const credentials = structuredClone(currentConfig.credentials);
	document.querySelectorAll('[data-credential]').forEach((select) => {
		credentials[select.dataset.credential].policy = select.value;
	});
	const config = {
		version: 1,
		assistant: { bindAddress: assistantBind, port: Number(byId('assistant-port').value) },
		gateway: {
			enabled: byId('gateway').checked || discord || slack,
			bindAddress: byId('gateway-bind').value.trim(),
			port: Number(byId('gateway-port').value)
		},
		credentials,
		portals: {
			discord: {
				enabled: discord,
				credential: byId('discord-credential').value,
				access: {
					guilds: csv(byId('discord-guilds').value),
					roles: csv(byId('discord-roles').value),
					users: csv(byId('discord-users').value),
					blockedUsers: csv(byId('discord-blocked-users').value)
				}
			},
			slack: {
				enabled: slack,
				credential: byId('slack-credential').value,
				access: {
					channels: csv(byId('slack-channels').value),
					users: csv(byId('slack-users').value),
					blockedUsers: csv(byId('slack-blocked-users').value)
				}
			}
		}
	};
	await operation('Saving configuration', async () => {
		await api.saveConfig(config);
		return api.action('start');
	});
});

byId('load-providers').addEventListener('click', async () => {
	const providers = await operation('Loading providers', () => api.providers());
	if (!providers) return;
	options(
		byId('provider'),
		providers.map((provider) => provider.id)
	);
	byId('provider-result').textContent = JSON.stringify(providers, null, 2);
});
byId('test-provider').addEventListener('click', async () => {
	const result = await operation('Testing provider readiness', () => api.readiness());
	if (result) byId('provider-result').textContent = JSON.stringify(result, null, 2);
});
byId('provider-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const result = await operation('Saving provider key', () =>
		api.providerKey({
			provider: byId('provider').value,
			key: byId('provider-key').value
		})
	);
	byId('provider-key').value = '';
	if (result) byId('provider-result').textContent = JSON.stringify(result, null, 2);
});

byId('credential-form').addEventListener('submit', (event) => {
	event.preventDefault();
	void operation('Creating credential', () =>
		api.credential({
			action: 'create',
			username: byId('credential-username').value,
			policy: byId('credential-policy').value
		})
	);
});
byId('rotate-credential').addEventListener('click', () =>
	operation('Rotating credential', () =>
		api.credential({ action: 'rotate', username: byId('credential-action-name').value })
	)
);
byId('remove-credential').addEventListener('click', () => {
	if (window.confirm('Remove this credential and revoke its key?'))
		void operation('Removing credential', () =>
			api.credential({ action: 'remove', username: byId('credential-action-name').value })
		);
});
byId('reveal-credential').addEventListener('click', async () => {
	if (!window.confirm('Reveal this bearer key? Anyone with it receives the selected policy.'))
		return;
	const result = await operation('Loading credential key', () =>
		api.credentialKey(byId('credential-action-name').value)
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
byId('mapping-form').addEventListener('submit', (event) => {
	event.preventDefault();
	void operation('Saving portal user mapping', () =>
		api.mapPortalUser({
			portal: byId('mapping-portal').value,
			userId: byId('mapping-user').value,
			username: byId('mapping-credential').value || undefined
		})
	);
});
byId('portal-token-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	await operation('Storing portal tokens', () =>
		api.portalToken({
			portal: byId('token-portal').value,
			botToken: byId('bot-token').value,
			appToken: byId('app-token').value
		})
	);
	byId('bot-token').value = '';
	byId('app-token').value = '';
});

byId('backup-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const result = await operation('Creating backup', () =>
		api.backup({
			destination: byId('backup-destination').value,
			includeProviderAuth: byId('backup-auth').checked,
			includeUserEnv: byId('backup-env').checked,
			includePortalMaps: byId('backup-maps').checked,
			includeOAuth: byId('backup-maps').checked
		})
	);
	if (result) byId('data-result').textContent = JSON.stringify(result, null, 2);
});
async function runImport(apply) {
	const result = await operation(apply ? 'Applying import' : 'Previewing import', () =>
		api.importData({
			sourceHome: byId('import-source').value,
			apply,
			includeProviderAuth: byId('import-auth').checked,
			includeUserEnv: byId('import-env').checked,
			includePortalMaps: byId('import-maps').checked,
			includeOAuth: byId('import-maps').checked
		})
	);
	if (result) byId('data-result').textContent = JSON.stringify(result, null, 2);
}
byId('preview-import').addEventListener('click', () => runImport(false));
byId('apply-import').addEventListener('click', () => {
	if (window.confirm('Apply this reviewed import plan to the fresh installation?'))
		void runImport(true);
});
byId('load-logs').addEventListener('click', async () => {
	const logs = await operation('Loading logs', () => api.logs());
	if (typeof logs === 'string') byId('logs').textContent = logs;
});

void refresh();
