import { saveConfigAndApply } from './configuration.js';
import { policyLabels, state } from './state.js';
import { all, byId, operation, setOptions } from './ui.js';

export function credentialOptions(snapshot) {
	return Object.entries(snapshot.config.credentials)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([value, config]) => ({ value, label: `${value} — ${policyLabels[config.policy]}` }));
}

export function clearClientKey(client) {
	byId(`${client}-key`).value = '';
	byId(`show-${client}-key`).checked = false;
	byId(`${client}-key`).type = 'password';
}

export function updateClientPolicy(client) {
	if (!state.currentSnapshot) return;
	const username = byId(`${client}-credential`).value;
	const policy = state.currentSnapshot.config.credentials[username]?.policy;
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

export function renderCredentials(snapshot) {
	const usernames = Object.keys(snapshot.config.credentials).sort();
	const policies = byId('credential-policies');
	policies.replaceChildren();
	for (const username of usernames) {
		const row = document.createElement('div');
		row.className = 'credential-row';
		const name = document.createElement('strong');
		name.textContent = username;
		const usage = document.createElement('small');
		const usedBy = ['discord', 'slack'].filter(
			(portal) => snapshot.config.portals[portal].credential === username
		);
		usage.textContent = usedBy.length
			? `Default for ${usedBy.join(' and ')}`
			: 'Available for MCP clients';
		const select = document.createElement('select');
		select.id = `credential-policy-${username}`;
		select.dataset.credential = username;
		select.setAttribute('aria-label', `${username} access level`);
		setOptions(
			select,
			Object.entries(policyLabels).map(([value, label]) => ({ value, label })),
			snapshot.config.credentials[username].policy
		);
		const manage = document.createElement('button');
		manage.type = 'button';
		manage.className = 'secondary';
		manage.textContent = 'Manage';
		manage.setAttribute('aria-label', `Manage ${username}`);
		manage.addEventListener('click', () => {
			byId('credential-action-name').value = username;
			byId('credential-key').value = '';
			byId('credential-key').type = 'password';
			byId('show-credential-key').checked = false;
			byId('credential-action-name').focus();
		});
		row.append(name, usage, select, manage);
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

export function renderMappings(snapshot) {
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

export function bindAccessEvents() {
	byId('access-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (!state.currentConfig) return;
		const config = structuredClone(state.currentConfig);
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
			() => state.api.credential({ action: 'create', username, policy }),
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
				() => state.api.credential({ action: 'rotate', username }),
				`Key for ${username} rotated. Update every client that uses it.`
			);
		}
	});

	byId('remove-credential').addEventListener('click', () => {
		const username = byId('credential-action-name').value;
		if (username && window.confirm(`Remove access for ${username} and revoke its key?`)) {
			void operation(
				'Removing access',
				() => state.api.credential({ action: 'remove', username }),
				`Access for ${username} removed.`
			);
		}
	});

	byId('reveal-credential').addEventListener('click', async () => {
		const username = byId('credential-action-name').value;
		if (!username) return;
		if (
			!window.confirm('Reveal this access key? Anyone with it receives the selected access level.')
		)
			return;
		const result = await operation(
			'Loading access key',
			() => state.api.credentialKey(username),
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
			() => state.api.mapPortalUser({ portal, userId, username }),
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
					state.api.mapPortalUser({
						portal: button.dataset.portal,
						userId: button.dataset.userId
					}),
				'Individual user override removed.'
			);
		}
	});
}
