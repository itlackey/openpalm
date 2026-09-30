import { renderCredentials, renderMappings } from './access.js';
import {
	renderConnectionDetails,
	renderPortalSecrets,
	updateConditionalConnections,
	updatePortalTokenFields
} from './connections.js';
import { endpoint, isHealthy } from './model.js';
import { loadProviders, renderReadiness } from './providers.js';
import { renderPhase, renderServices } from './runtime.js';
import { renderPreferences } from './preferences.js';
import { state } from './state.js';
import {
	byId,
	captureDirtyForms,
	message,
	notice,
	restoreDirtyForms,
	setBadge,
	setSkipTarget,
	setText,
	showView
} from './ui.js';

export function render(snapshot, options = {}) {
	const drafts = options.preserveDirty === false ? {} : captureDirtyForms();
	const previousPhase = state.currentSnapshot?.phase;
	state.currentSnapshot = snapshot;
	state.currentConfig = snapshot.config;
	state.renderingSnapshot = true;
	byId('install-assistant-port').value = String(snapshot.config.assistant.port);
	byId('install-gateway-port').value = String(snapshot.config.gateway.port);
	byId('recovery-assistant-port').value = String(snapshot.config.assistant.port);
	byId('recovery-gateway-port').value = String(snapshot.config.gateway.port);
	renderPhase(snapshot.phase);
	if (snapshot.phase === 'not_installed') {
		state.renderingSnapshot = false;
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
	renderPreferences(snapshot);
	renderCredentials(snapshot);
	renderMappings(snapshot);
	renderPortalSecrets(snapshot);
	renderConnectionDetails(snapshot);
	restoreDirtyForms(drafts);
	updateConditionalConnections();
	updatePortalTokenFields();
	state.renderingSnapshot = false;

	if (!state.lastReadiness) {
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
		renderReadiness(state.lastReadiness);
	}

	if (snapshot.phase === 'ready' && previousPhase === 'setup_incomplete') {
		showView('overview');
	} else if (snapshot.phase === 'ready') {
		showView(state.currentView);
	}

	const assistant = snapshot.services.find((service) => service.name === 'assistant');
	if (!state.providersLoaded && isHealthy(assistant))
		queueMicrotask(() => void loadProviders(false));
}

export async function showFatalError(error) {
	byId('loading-state').hidden = true;
	byId('install-section').hidden = true;
	byId('app-shell').hidden = true;
	byId('error-state').hidden = false;
	setText('error-message', message(error));
	setSkipTarget('error-state');
	try {
		setText('error-home', await state.api.selectedHome());
	} catch {
		setText('error-home', 'Selected OpenPalm home');
	}
	byId('error-state').focus();
}

export async function refresh(announce = false) {
	try {
		const snapshot = await state.api.snapshot();
		render(snapshot);
		if (announce) notice('Status refreshed.', 'success');
	} catch (error) {
		if (state.currentSnapshot) {
			notice(`Could not refresh status: ${message(error)}`, 'error', { persist: true });
			return;
		}
		await showFatalError(error);
		notice(message(error), 'error', { persist: true });
	}
}
