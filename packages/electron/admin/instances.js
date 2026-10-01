import { refresh } from './snapshot.js';
import { state } from './state.js';
import { all, byId, message, notice, setBusy, setSkipTarget, setText } from './ui.js';

export function renderWelcome(welcome) {
	byId('loading-state').hidden = true;
	byId('error-state').hidden = true;
	byId('install-section').hidden = true;
	byId('app-shell').hidden = true;
	byId('instance-welcome').hidden = false;
	document.body.dataset.phase = 'welcome';
	setSkipTarget('instance-welcome');
	const previous = welcome.recentInstances[0];
	const primary = previous || welcome.defaultInstance;
	setText('open-recent-instance', previous ? 'Open previous instance' : 'Open default instance');
	setText('primary-instance-path', primary.homeDir);
	byId('open-recent-instance').onclick = () => void openInstance(primary);
	byId('default-instance-option').hidden = primary.homeDir === welcome.defaultInstance.homeDir;
	setText('default-instance-path', welcome.defaultInstance.homeDir);
	byId('open-default-instance').onclick = () => void openInstance(welcome.defaultInstance);
	const recent = byId('recent-instances');
	recent.replaceChildren();
	const others = welcome.recentInstances.filter(
		(item) => item.homeDir !== primary.homeDir && item.homeDir !== welcome.defaultInstance.homeDir
	);
	byId('recent-instances-section').hidden = !others.length;
	for (const target of others) {
		const row = document.createElement('div');
		row.className = 'instance-row';
		const path = document.createElement('span');
		path.className = 'instance-path';
		path.textContent = target.homeDir;
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'secondary';
		button.textContent = 'Open';
		button.setAttribute('aria-label', `Open ${target.homeDir}`);
		button.addEventListener('click', () => void openInstance(target));
		row.append(path, button);
		recent.append(row);
	}
	setText('instance-preference-warning', welcome.preferenceError || '');
	byId('instance-preference-warning').hidden = !welcome.preferenceError;
}

export async function openInstance(target) {
	if (state.operationInFlight) return;
	setBusy(true);
	try {
		await state.api.openInstance(target);
		// Reload all renderer modules: no forms, keys, OAuth or restore previews
		// from the previously managed instance survive a switch.
		window.location.reload();
	} catch (error) {
		notice(message(error), 'error', { persist: true });
	} finally {
		setBusy(false);
	}
}

export async function showInstances() {
	if (state.operationInFlight) return;
	if (
		(state.dirtyForms.size || state.activeOAuth) &&
		!window.confirm(
			'Return to instances? Unsaved changes and unfinished sign-in steps will be discarded. Running stacks will not be stopped.'
		)
	)
		return;
	setBusy(true);
	try {
		await state.api.closeInstance();
		window.location.reload();
	} catch (error) {
		notice(message(error), 'error', { persist: true });
	} finally {
		setBusy(false);
	}
}

export function bindInstanceEvents() {
	byId('choose-instance').addEventListener('click', async () => {
		if (state.operationInFlight) return;
		const directory = await state.api.chooseDirectory({ purpose: 'instance' }).catch((error) => {
			notice(message(error), 'error', { persist: true });
		});
		if (directory) await openInstance({ kind: 'local', homeDir: directory });
	});
	for (const button of all('[data-instance-switch]'))
		button.addEventListener('click', () => void showInstances());
}

export async function initializeAdmin() {
	try {
		const welcome = await state.api.welcome();
		if (welcome.selectedInstance) await refresh(false);
		else renderWelcome(welcome);
	} catch (error) {
		byId('loading-state').hidden = true;
		notice(`Could not load instances: ${message(error)}`, 'error', { persist: true });
	}
}
