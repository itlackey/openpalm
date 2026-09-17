const api = window.openpalmAdmin;
let currentConfig = null;

const byId = (id) => document.getElementById(id);

function notice(message, error = false) {
	const element = byId('notice');
	element.textContent = message;
	element.classList.toggle('error', error);
}

function render(snapshot) {
	currentConfig = snapshot.config;
	byId('home').textContent = `${snapshot.homeDir} · ${snapshot.configPath}`;
	byId('gateway').checked = snapshot.config.gateway.enabled;
	byId('discord').checked = snapshot.config.portals.discord.enabled;
	byId('slack').checked = snapshot.config.portals.slack.enabled;
	byId('assistant-bind').value = snapshot.config.assistant.bindAddress;
	byId('assistant-port').value = String(snapshot.config.assistant.port);
	byId('gateway-bind').value = snapshot.config.gateway.bindAddress;
	byId('gateway-port').value = String(snapshot.config.gateway.port);
	const policies = byId('credential-policies');
	policies.replaceChildren();
	const usernames = Object.keys(snapshot.config.credentials).sort();
	for (const username of usernames) {
		const label = document.createElement('label');
		label.append(`${username} policy `);
		const select = document.createElement('select');
		select.dataset.credential = username;
		for (const policy of ['chat', 'read', 'full']) {
			const option = document.createElement('option');
			option.value = policy;
			option.textContent = policy;
			select.append(option);
		}
		select.value = snapshot.config.credentials[username].policy;
		label.append(select);
		policies.append(label);
	}
	for (const portal of ['discord', 'slack']) {
		const select = byId(`${portal}-credential`);
		select.replaceChildren();
		for (const username of usernames) {
			const option = document.createElement('option');
			option.value = username;
			option.textContent = username;
			select.append(option);
		}
		select.value = snapshot.config.portals[portal].credential;
	}
	const services = byId('services');
	services.replaceChildren();
	if (snapshot.services.length === 0) {
		services.textContent = snapshot.dockerError || 'No containers are running.';
	} else {
		for (const service of snapshot.services) {
			const row = document.createElement('div');
			row.className = 'service';
			row.innerHTML = `<strong></strong><span></span>`;
			row.querySelector('strong').textContent = service.name;
			row.querySelector('span').textContent = [service.state, service.health]
				.filter(Boolean)
				.join(' · ');
			services.append(row);
		}
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

byId('refresh').addEventListener('click', refresh);
document.querySelectorAll('[data-action]').forEach((button) => {
	button.addEventListener('click', async () => {
		notice(`${button.dataset.action} in progress…`);
		try {
			render(await api.action(button.dataset.action));
			notice(`Stack ${button.dataset.action} completed.`);
		} catch (error) {
			notice(error.message || String(error), true);
		}
	});
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
			'Direct OpenCode access at this address bypasses Guardian. Continue only on a trusted network with appropriate TLS.'
		)
	) {
		return;
	}
	if (!currentConfig) return;
	const credentials = structuredClone(currentConfig.credentials);
	document.querySelectorAll('[data-credential]').forEach((select) => {
		credentials[select.dataset.credential].policy = select.value;
	});
	const config = {
		version: 2,
		assistant: {
			bindAddress: assistantBind,
			port: Number(byId('assistant-port').value)
		},
		gateway: {
			enabled: byId('gateway').checked || discord || slack,
			bindAddress: byId('gateway-bind').value.trim(),
			port: Number(byId('gateway-port').value)
		},
		credentials,
		portals: {
			discord: { enabled: discord, credential: byId('discord-credential').value },
			slack: { enabled: slack, credential: byId('slack-credential').value }
		}
	};
	notice('Saving configuration…');
	try {
		await api.saveConfig(config);
		render(await api.action('start'));
		notice('Configuration saved and applied.');
	} catch (error) {
		notice(error.message || String(error), true);
	}
});

byId('load-logs').addEventListener('click', async () => {
	try {
		byId('logs').textContent = await api.logs();
	} catch (error) {
		notice(error.message || String(error), true);
	}
});

void refresh();
