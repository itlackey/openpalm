import { state } from './state.js';
import { all, byId, message, notice, operation, setBadge, setBusy } from './ui.js';
import { refresh } from './snapshot.js';

let tool;
let running = false;
let timer;
let starting = false;
let connectionOnly = false;

export function renderRemoteStatus(snapshot) {
	for (const name of ['claude', 'codex']) {
		const enabled = snapshot.config.assistant[`${name}Remote`] === true;
		setBadge(
			byId(`${name}-remote-status`),
			enabled ? 'Startup enabled · client connection not checked' : 'Startup off',
			'neutral'
		);
		for (const button of all(`[data-remote-connect="${name}"]`))
			button.disabled = state.operationInFlight || !enabled;
		for (const button of all(`[data-remote-disable="${name}"]`)) button.hidden = !enabled;
	}
}

export function remoteStageText(progress) {
	if (progress.error) return progress.error;
	if (progress.enabled) return 'Startup enabled. Connect your client and verify a real request.';
	return (
		{
			starting: 'Preparing your agent…',
			sandbox: 'Checking that this computer can safely run Codex…',
			'sign-in': 'Finish account sign-in in your browser.',
			account: 'Checking your account…',
			'trust-and-consent': 'Review the workspace and remote-access prompts below.',
			enabling: 'Enabling remote startup…',
			pairing: 'Getting your connection details…',
			connection: 'Your private connection details are below.',
			failed: 'Setup did not finish. Remote startup is off.'
		}[progress.stage] ?? 'Preparing remote access…'
	);
}

function showProgress(progress) {
	running = progress.running;
	byId('remote-stage').textContent = remoteStageText(progress);
	const answering =
		running &&
		tool === 'claude' &&
		['sign-in', 'trust-and-consent'].includes(progress.stage) &&
		Boolean(progress.output.trim());
	byId('remote-answer-field').hidden = !answering;
	byId('remote-answer-label').textContent =
		progress.stage === 'trust-and-consent'
			? 'Your answer, as requested in the native prompt'
			: 'Sign-in code, if requested';
	byId('remote-guidance').textContent =
		progress.stage === 'trust-and-consent'
			? 'Read the native prompts before answering. OpenPalm will not approve workspace trust or remote access for you.'
			: progress.stage === 'sign-in'
				? 'Complete sign-in in the browser. If Claude asks for a code, paste it below. Codex device codes are entered in the browser.'
				: 'Keep connection details private. Startup alone does not confirm that your client is connected.';
	const step = ['starting', 'sandbox'].includes(progress.stage)
		? 'access'
		: ['sign-in', 'account', 'trust-and-consent'].includes(progress.stage)
			? 'sign-in'
			: 'connect';
	for (const item of all('[data-remote-step]'))
		item.setAttribute('aria-current', item.dataset.remoteStep === step ? 'step' : 'false');
	byId('remote-begin').hidden = running || progress.enabled;
	byId('remote-output').value = progress.output;
	if (answering || progress.enabled || progress.error || progress.stage === 'connection')
		byId('remote-output-details').open = true;
	byId('remote-output').scrollTop = byId('remote-output').scrollHeight;
	byId('remote-send').disabled = !answering;
	byId('remote-send').hidden = !answering;
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
			byId('remote-heading').textContent = connectionOnly
				? tool === 'claude'
					? 'Open Claude remote session'
					: 'Get Codex pairing code'
				: tool === 'claude'
					? 'Enable Claude Remote Control'
					: 'Enable Codex remote (experimental)';
			byId('remote-trust-field').hidden = connectionOnly;
			byId('remote-trust').required = !connectionOnly;
			byId('remote-begin').textContent = connectionOnly ? 'Get connection details' : 'Continue';
			byId('remote-begin').hidden = false;
			byId('remote-advanced').hidden = connectionOnly || tool !== 'codex';
			byId('remote-advanced').open = false;
			byId('remote-sandbox-field').hidden = connectionOnly || tool !== 'codex';
			byId('remote-sandbox').value =
				state.currentConfig?.assistant.codexSandbox ?? 'workspace-write';
			byId('remote-trust').checked = false;
			byId('remote-stage').textContent = connectionOnly
				? 'Get fresh private connection details from the running agent.'
				: 'Ready to begin. Existing remote startup is paused during setup.';
			byId('remote-output').value = '';
			byId('remote-prompts').hidden = true;
			byId('remote-output-details').open = false;
			byId('remote-answer-field').hidden = true;
			byId('remote-send').hidden = true;
			byId('remote-guidance').textContent = connectionOnly
				? 'Use these details in a supported client. Do not share pairing codes or links.'
				: 'Sign in through your browser, then approve any account or workspace prompts yourself.';
			for (const item of all('[data-remote-step]'))
				item.setAttribute(
					'aria-current',
					!connectionOnly && item.dataset.remoteStep === 'access' ? 'step' : 'false'
				);
			byId('remote-steps').hidden = connectionOnly;
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
							...(tool === 'codex' ? { sandbox: byId('remote-sandbox').value } : {})
						}
			);
			byId('remote-trust').disabled = true;
			byId('remote-sandbox').disabled = true;
			byId('remote-cancel').disabled = false;
			showProgress(progress);
		} catch (error) {
			setBusy(false);
			byId('remote-stage').textContent = message(error);
			byId('remote-cancel').disabled = false;
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
	for (const button of all('[data-remote-disable]'))
		button.addEventListener('click', async () => {
			const name = button.dataset.remoteDisable;
			const result = await operation(
				'Disabling remote startup',
				() => state.api.remote({ action: 'disable', tool: name }),
				'Remote startup disabled. Account sign-in is retained.'
			);
			if (result) await refresh(false);
		});
}
