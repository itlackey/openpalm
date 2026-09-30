import { friendlyServiceName, isHealthy, isRunning } from './model.js';
import { refresh, render } from './snapshot.js';
import { state } from './state.js';
import { all, byId, notice, operation, setBadge, setSkipTarget, setText, showView } from './ui.js';

export function renderPhase(phase) {
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
		showView(
			state.currentView === 'provider' && state.lastReadiness?.ok ? 'overview' : state.currentView
		);
	}
}

export function renderRuntimeControls(snapshot) {
	const assistant = snapshot.services.find((service) => service.name === 'assistant');
	const running = isRunning(assistant);
	byId('start-stack').disabled = state.operationInFlight || running;
	byId('restart-stack').disabled = state.operationInFlight || !running;
	byId('stop-stack').disabled = state.operationInFlight || snapshot.services.length === 0;
}

export function renderServices(snapshot) {
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

export function bindRuntimeEvents() {
	byId('install-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (!state.currentConfig) return;
		const assistantPort = Number(byId('install-assistant-port').value);
		const gatewayPort = Number(byId('install-gateway-port').value);
		if (assistantPort === gatewayPort) {
			notice('The Assistant and protected-access ports must be different.', 'error', {
				persist: true
			});
			byId('install-gateway-port').focus();
			return;
		}
		const config = structuredClone(state.currentConfig);
		config.assistant.port = assistantPort;
		config.gateway.port = gatewayPort;
		const result = await operation(
			'Setting up OpenPalm',
			() => state.api.install(config),
			'OpenPalm is installed. Next, connect your AI provider.'
		);
		if (!result) await refresh(false);
	});

	byId('recovery-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (!state.currentConfig) return;
		const assistantPort = Number(byId('recovery-assistant-port').value);
		const gatewayPort = Number(byId('recovery-gateway-port').value);
		if (assistantPort === gatewayPort) {
			notice('The Assistant and protected-access ports must be different.', 'error', {
				persist: true
			});
			byId('recovery-gateway-port').focus();
			return;
		}
		const config = structuredClone(state.currentConfig);
		config.assistant.port = assistantPort;
		config.gateway.port = gatewayPort;
		await operation(
			'Retrying OpenPalm startup',
			async () => {
				const saved = await state.api.saveConfig(config);
				render(saved);
				return state.api.action('start');
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
			void operation(labels[action][0], () => state.api.action(action), labels[action][1]);
		});
	});
}
