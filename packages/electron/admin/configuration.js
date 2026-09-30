import { render } from './snapshot.js';
import { state } from './state.js';
import { byId, notice, operation, setFormClean } from './ui.js';

export async function saveConfigAndApply(config, formId, action, progress, success) {
	return operation(
		progress,
		async () => {
			const saved = await state.api.saveConfig(config);
			setFormClean(formId);
			render(saved);
			return state.api.action(action);
		},
		success
	);
}

export function bindConfigurationEvents() {
	byId('network-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (!state.currentConfig) return;
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
		const config = structuredClone(state.currentConfig);
		config.assistant = { ...config.assistant, bindAddress: assistantBind, port: assistantPort };
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
}
