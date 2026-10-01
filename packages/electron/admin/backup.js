import { loadProviders } from './providers.js';
import { state } from './state.js';
import { byId, message, notice, operation, setBadge } from './ui.js';

export function importInput(apply) {
	return {
		sourceHome: byId('import-source').value.trim(),
		apply,
		...(apply ? { acknowledgeUnrestored: byId('import-acknowledge').checked } : {}),
		...(apply && state.importPreviewDigest ? { previewDigest: state.importPreviewDigest } : {}),
		includeProviderAuth: byId('import-auth').checked,
		includeUserEnv: byId('import-env').checked,
		includePortalMaps: byId('import-maps').checked,
		includeOAuth: byId('import-maps').checked
	};
}

export function importSignature() {
	return JSON.stringify(importInput(false));
}

export function invalidateImportPreview() {
	state.importPreviewSignature = null;
	state.importPreviewDigest = null;
	byId('apply-import').disabled = true;
	byId('import-acknowledge').checked = false;
}

export function renderImportPlan(result, applied) {
	byId('data-result').value = JSON.stringify(result, null, 2);
	const summary = byId('import-summary');
	summary.replaceChildren();
	const title = document.createElement('strong');
	const detail = document.createElement('span');
	if (applied) {
		title.textContent = 'Portable files restored and verified.';
		detail.textContent = `${result.copyCount} items copied. This is not a full migration: history and other unrestored data need separate acceptance. Tasks remain inactive.`;
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
	const inventory = byId('import-preservation');
	inventory.replaceChildren();
	for (const item of result.preservation) {
		const row = document.createElement('details');
		row.className = 'disclosure preservation-row';
		const heading = document.createElement('summary');
		const name = document.createElement('span');
		name.textContent = item.category;
		const badge = document.createElement('span');
		setBadge(
			badge,
			item.disposition === 'selected'
				? 'Selected'
				: item.disposition === 'review-required'
					? 'Separate recovery'
					: 'Not included',
			item.disposition === 'selected' ? 'success' : 'neutral'
		);
		heading.append(name, badge);
		const note = document.createElement('p');
		note.className = 'help-text';
		note.textContent = item.note;
		row.append(heading, note);
		inventory.append(row);
	}
	byId('import-acknowledge-row').hidden = !result.reviewRequired || applied;
}

export async function chooseDirectory(purpose, inputId) {
	try {
		const selected = await state.api.chooseDirectory({ purpose });
		if (!selected) return;
		byId(inputId).value = selected;
		byId(inputId).dispatchEvent(new Event('input', { bubbles: true }));
		byId(inputId).focus();
	} catch (error) {
		notice(message(error), 'error', { persist: true });
	}
}

export function bindBackupEvents() {
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
				state.api.backup({
					destination,
					includeProviderAuth: byId('backup-auth').checked,
					includeUserEnv: byId('backup-env').checked,
					includePortalMaps: byId('backup-maps').checked,
					includeOAuth: byId('backup-maps').checked
				}),
			'Portable backup created. Native conversation history is not included.'
		);
		if (!result) return;
		byId('backup-result').value = JSON.stringify(result, null, 2);
		byId('backup-summary').className = 'inline-status success';
		byId('backup-summary').hidden = false;
		byId('backup-summary').replaceChildren();
		const title = document.createElement('strong');
		title.textContent = `${result.files.length} portable file${result.files.length === 1 ? '' : 's'} backed up.`;
		const detail = document.createElement('span');
		detail.textContent = `Saved to ${destination}. Native history, runtime artifacts and external sources are not included.${result.warnings.length ? ` ${result.warnings.length} warnings need review.` : ''}`;
		byId('backup-summary').append(title, detail);
	});

	for (const eventName of ['input', 'change']) {
		byId('import-form').addEventListener(eventName, (event) => {
			if (event.target.id === 'import-acknowledge') {
				byId('apply-import').disabled =
					!state.importPreviewDigest || !byId('import-acknowledge').checked;
				return;
			}
			invalidateImportPreview();
		});
	}

	byId('preview-import').addEventListener('click', async () => {
		const signature = importSignature();
		const result = await operation(
			'Previewing restore',
			() => state.api.importData(importInput(false)),
			'Restore preview is ready for review.'
		);
		if (!result) return;
		renderImportPlan(result, false);
		state.importPreviewSignature = signature;
		state.importPreviewDigest = result.conflicts > 0 ? null : result.digest;
		byId('import-acknowledge').checked = false;
		byId('apply-import').disabled = result.conflicts > 0 || result.reviewRequired;
	});

	byId('apply-import').addEventListener('click', async () => {
		if (state.importPreviewSignature !== importSignature() || !state.importPreviewDigest) {
			notice('Preview these restore choices again before applying them.', 'error', {
				persist: true
			});
			invalidateImportPreview();
			return;
		}
		if (
			!window.confirm(
				'Copy the reviewed portable files? Native history and other unrestored data will not be copied.'
			)
		)
			return;
		const result = await operation(
			'Applying restore',
			() => state.api.importData(importInput(true)),
			'Restore applied. Your imported data is ready for review.'
		);
		if (result) {
			renderImportPlan(result, true);
			state.providersLoaded = false;
			await loadProviders(false);
			invalidateImportPreview();
		}
	});
}
