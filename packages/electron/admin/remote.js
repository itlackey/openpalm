import { state } from './state.js';
import { all, byId, message, notice, setBusy } from './ui.js';
import { refresh } from './snapshot.js';

let tool;
let running = false;
let timer;
let starting = false;
let connectionOnly = false;

function showProgress(progress) {
	running = progress.running;
	byId('remote-stage').textContent =
		progress.error ??
		(progress.enabled
			? 'Startup enabled. Connect your supported client and verify a real tool request.'
			: `Setup: ${progress.stage}`);
	byId('remote-output').value = progress.output;
	byId('remote-output').scrollTop = byId('remote-output').scrollHeight;
	byId('remote-send').disabled =
		!running || !['sign-in', 'trust-and-consent'].includes(progress.stage);
	byId('remote-cancel').textContent = running ? 'Cancel setup' : 'Close';
	if (!running) {
		clearTimeout(timer);
		setBusy(false);
		byId('remote-begin').disabled = false;
		byId('remote-trust').disabled = false;
		byId('remote-sandbox').disabled = false;
		byId('remote-answer').value = '';
		void refresh(false);
	} else {
		timer = setTimeout(async () => {
			try {
				showProgress(await state.api.remote({ action: 'progress', tool }));
			} catch (error) {
				byId('remote-stage').textContent =
					message(error); /* Keep Cancel available; never report success. */
			}
		}, 1000);
	}
}

export function bindRemoteEvents() {
	for (const button of all('[data-remote-enable], [data-remote-connect]'))
		button.addEventListener('click', () => {
			connectionOnly = Boolean(button.dataset.remoteConnect);
			tool = button.dataset.remoteEnable ?? button.dataset.remoteConnect;
			byId('remote-heading').textContent =
				connectionOnly
					? tool === 'claude'
						? 'Open Claude remote session'
						: 'Get Codex pairing code'
					: tool === 'claude'
						? 'Enable Claude Remote Control'
						: 'Enable Codex remote (experimental)';
			byId('remote-trust-field').hidden = connectionOnly;
			byId('remote-trust').required = !connectionOnly;
			byId('remote-begin').textContent = connectionOnly
				? 'Get connection details'
				: 'Begin guided setup';
			byId('remote-sandbox-field').hidden = connectionOnly || tool !== 'codex';
			byId('remote-sandbox').value =
				state.currentConfig?.assistant.codexSandbox ?? 'workspace-write';
			byId('remote-trust').checked = false;
			byId('remote-stage').textContent =
				connectionOnly
					? 'Get fresh private connection details from the running agent.'
					: 'Ready to begin. Existing remote startup is paused during setup.';
			byId('remote-output').value = '';
			byId('remote-prompts').hidden = true;
			byId('remote-answer').value = '';
			byId('remote-send').disabled = true;
			byId('remote-cancel').textContent = 'Cancel';
			byId('remote-dialog').showModal();
		});
	byId('remote-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (running) {
			byId('remote-send').click();
			return;
		}
		if (starting || (!connectionOnly && !byId('remote-trust').checked)) return;
		starting = true;
		setBusy(true);
		byId('remote-prompts').hidden = false;
		byId('remote-stage').textContent = 'Preparing Assistant…';
		try {
			const progress = await state.api.remote(
				connectionOnly
					? { action: 'connection', tool }
					: {
							action: 'enable',
							tool,
							trusted: true,
							sandbox: byId('remote-sandbox').value
						}
			);
			byId('remote-trust').disabled = true;
			byId('remote-sandbox').disabled = true;
			byId('remote-cancel').disabled = false;
			showProgress(progress);
		} catch (error) {
			setBusy(false);
			byId('remote-stage').textContent = message(error);
		} finally {
			starting = false;
		}
	});
	byId('remote-send').addEventListener('click', async () => {
		const answer = byId('remote-answer').value;
		byId('remote-answer').value = '';
		try {
			await state.api.remote({ action: 'input', tool, input: answer });
		} catch (error) {
			byId('remote-stage').textContent = message(error);
		}
	});
	const cancel = async () => {
		if (starting) return;
		clearTimeout(timer);
		if (running) {
			byId('remote-cancel').disabled = true;
			byId('remote-stage').textContent = 'Cancelling setup and leaving startup off…';
			try {
				showProgress(await state.api.remote({ action: 'cancel', tool }));
			} catch (error) {
				notice(message(error), 'error', { persist: true });
			} finally {
				byId('remote-cancel').disabled = false;
			}
		}
		if (running) return;
		byId('remote-answer').value = '';
		byId('remote-output').value = '';
		byId('remote-dialog').close();
	};
	byId('remote-cancel').addEventListener('click', cancel);
	byId('remote-dialog').addEventListener('cancel', (event) => {
		event.preventDefault();
		void cancel();
	});
}
