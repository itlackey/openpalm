import { loadProviders } from './providers.js';
import { state } from './state.js';
import { byId, message, notice, operation } from './ui.js';

export function importInput(apply) {
	return {
		sourceHome: byId('import-source').value.trim(),
		apply,
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
}

export function renderImportPlan(result, applied) {
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
			() => state.api.importData(importInput(false)),
			'Restore preview is ready for review.'
		);
		if (!result) return;
		renderImportPlan(result, false);
		state.importPreviewSignature = signature;
		state.importPreviewDigest = result.digest;
		byId('apply-import').disabled = result.conflicts > 0;
	});

	byId('apply-import').addEventListener('click', async () => {
		if (state.importPreviewSignature !== importSignature() || !state.importPreviewDigest) {
			notice('Preview these restore choices again before applying them.', 'error', {
				persist: true
			});
			invalidateImportPreview();
			return;
		}
		if (!window.confirm('Apply this reviewed restore plan to the fresh OpenPalm installation?'))
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
