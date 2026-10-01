import { clearClientKey, updateClientPolicy } from './access.js';
import { saveConfigAndApply } from './configuration.js';
import { csv, endpoint } from './model.js';
import { state } from './state.js';
import { all, byId, notice, operation, setBadge, setText, showClient } from './ui.js';

export function secretConfigured(snapshot, portal, name) {
	return snapshot.portalSecrets[portal]?.[name] === true;
}

export function renderPortalSecrets(snapshot) {
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

export function updateGuardianGuide() {
	if (!state.currentSnapshot) return;
	const saved = state.currentSnapshot.config.gateway.enabled;
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

export function updateConditionalConnections() {
	const guardian = byId('gateway').checked || byId('discord').checked || byId('slack').checked;
	byId('guardian-settings').hidden = !guardian;
	byId('discord-settings').hidden = !byId('discord').checked;
	byId('slack-settings').hidden = !byId('slack').checked;
	updateGuardianGuide();
}

export function updatePortalTokenFields() {
	const slack = byId('token-portal').value === 'slack';
	const snapshot = state.currentSnapshot;
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

export function showPortalTokenForm(portal, field = 'bot-token') {
	byId('token-portal').value = portal;
	updatePortalTokenFields();
	byId('portal-token-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
	queueMicrotask(() => byId(field).focus());
}

export function renderConnectionDetails(snapshot) {
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
	showClient(state.currentClient);
	updateGuardianGuide();
}

export function renderNetworkDetails(snapshot) {
	const assistantUrl = endpoint(
		snapshot.config.assistant.bindAddress,
		snapshot.config.assistant.port
	);
	const guardianUrl = endpoint(
		snapshot.config.gateway.bindAddress,
		snapshot.config.gateway.port,
		'/mcp'
	);
	const healthUrl = endpoint(
		snapshot.config.gateway.bindAddress,
		snapshot.config.gateway.port,
		'/health'
	);
	setText('assistant-url', assistantUrl);
	const link = byId('assistant-url-detail');
	link.textContent = assistantUrl;
	link.setAttribute('href', assistantUrl);
	link.hidden = false;
	setText('guardian-url', guardianUrl);
	setText('guardian-mcp-url-detail', guardianUrl);
	setText('guardian-health-url-detail', healthUrl);
	setText(
		'guardian-api-status',
		snapshot.config.gateway.enabled
			? 'Guardian MCP is enabled.'
			: 'Guardian MCP is disabled. Enable it in Connections to use these endpoints.'
	);
}

export async function loadDirectPassword(copyOnly) {
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
			const value = await state.api.assistantPassword();
			if (copyOnly) await state.api.copyText(value.password);
			return value;
		},
		copyOnly ? 'OpenCode password copied.' : 'OpenCode password loaded and kept masked.'
	);
	if (result && !copyOnly) byId('direct-password').value = result.password;
}

export async function loadClientKey(client, copyOnly) {
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
			const value = await state.api.credentialKey(username);
			if (copyOnly) await state.api.copyText(value.key);
			return value;
		},
		copyOnly ? `Key for ${username} copied.` : `Key for ${username} loaded and kept masked.`
	);
	if (result && !copyOnly) byId(`${client}-key`).value = result.key;
}

export function bindConnectionsEvents() {
	for (const id of ['gateway', 'discord', 'slack']) {
		byId(id).addEventListener('change', updateConditionalConnections);
	}

	for (const button of all('[data-enable-gateway]')) {
		button.addEventListener('click', () => {
			byId('gateway').checked = true;
			state.dirtyForms.add('connections-form');
			updateConditionalConnections();
			byId('connections-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
			notice('Protected access selected. Review and save Connections to apply it.', 'progress', {
				persist: true
			});
		});
	}

	byId('connections-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (!state.currentConfig || !state.currentSnapshot) return;
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
		if (discord && !secretConfigured(state.currentSnapshot, 'discord', 'discord_bot_token')) {
			notice('Store a Discord bot token before enabling Discord.', 'error', { persist: true });
			showPortalTokenForm('discord');
			return;
		}
		if (
			slack &&
			(!secretConfigured(state.currentSnapshot, 'slack', 'slack_bot_token') ||
				!secretConfigured(state.currentSnapshot, 'slack', 'slack_app_token'))
		) {
			notice('Store both Slack tokens before enabling Slack.', 'error', { persist: true });
			showPortalTokenForm(
				'slack',
				secretConfigured(state.currentSnapshot, 'slack', 'slack_bot_token')
					? 'app-token'
					: 'bot-token'
			);
			return;
		}
		const config = structuredClone(state.currentConfig);
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

	for (const button of all('[data-copy-field]')) {
		button.addEventListener('click', async () => {
			const value = byId(button.dataset.copyField).textContent;
			await operation('Copying connection value', () => state.api.copyText(value), 'Copied.');
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
			() => state.api.openExternal(url),
			'Extension download opened.'
		);
	});

	for (const button of all('[data-external-url]')) {
		button.addEventListener(
			'click',
			() =>
				void operation(
					'Opening setup page',
					() => state.api.openExternal(button.dataset.externalUrl),
					'Setup page opened.'
				)
		);
	}

	for (const button of all('[data-token-target]')) {
		button.addEventListener('click', () => showPortalTokenForm(button.dataset.tokenTarget));
	}

	byId('token-portal').addEventListener('change', updatePortalTokenFields);

	byId('portal-token-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		const portal = byId('token-portal').value;
		const botToken = byId('bot-token').value;
		const appToken = byId('app-token').value;
		const botConfigured = secretConfigured(
			state.currentSnapshot,
			portal,
			portal === 'slack' ? 'slack_bot_token' : 'discord_bot_token'
		);
		const appConfigured =
			portal === 'slack' && secretConfigured(state.currentSnapshot, 'slack', 'slack_app_token');
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
				state.api.portalToken({
					portal,
					botToken,
					appToken: portal === 'slack' ? appToken : undefined
				}),
			`${portal === 'slack' ? 'Slack' : 'Discord'} tokens stored privately.`
		);
		if (result) {
			byId('bot-token').value = '';
			byId('app-token').value = '';
		}
	});
}
