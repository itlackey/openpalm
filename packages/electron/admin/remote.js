import { state } from './state.js';
import { all, byId, message, notice, operation, setBadge, setBusy } from './ui.js';
import { refresh } from './snapshot.js';

let tool;
let running = false;
let timer;
let starting = false;
let connectionOnly = false;
let recallOnly = false;
let recallReview;
let reviewRequest = 0;

export function recallStatusLabel(review) {
	return (
		{ installed: 'Installed', 'approval-needed': 'Approval needed', ready: 'Ready' }[
			review?.status
		] ?? 'Not checked'
	);
}

export function renderRemoteStatus(snapshot) {
	setBadge(
		byId('codex-recall-status'),
		recallStatusLabel(snapshot.codexRecall),
		snapshot.codexRecall?.status === 'ready' ? 'success' : 'neutral'
	);
	byId('codex-recall-guidance').textContent =
		snapshot.codexRecallError ??
		(snapshot.codexRecall?.status === 'approval-needed'
			? 'AKM hooks need approval or are partly disabled. Review to enable complete automatic recall.'
			: snapshot.codexRecall?.status === 'ready'
				? 'Native approval saved. Knowledge recall is ready for new Codex sessions.'
				: 'Review AKM hooks here; no Codex command is needed. Start Assistant to check approval.');
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

async function loadRecall() {
	const request = ++reviewRequest;
	recallReview = undefined;
	byId('remote-recall').checked = false;
	byId('remote-recall').disabled = true;
	byId('remote-begin').disabled = true;
	byId('remote-recall-status').textContent = 'Checking native hook approval…';
	byId('remote-recall-definitions').value = '';
	byId('remote-recall-disable').hidden = true;
	try {
		const review = await state.api.codexRecall({ action: 'review' });
		if (request !== reviewRequest || !byId('remote-dialog').open) return;
		recallReview = review;
		byId('remote-recall-status').textContent =
			`${recallStatusLabel(review)}${review.hooks.some((h) => h.trust === 'modified') ? ' · definitions changed; review again' : ''}`;
		byId('remote-recall-definitions').value = review.hooks
			.map(
				(h) =>
					`${h.event} (${h.trust}${h.enabled ? '' : ', off'})\n${h.command}\nDefinition: ${h.sourcePath}\nHash: ${h.hash}`
			)
			.join('\n\n');
		byId('remote-recall').disabled = false;
		byId('remote-recall').checked = review.status === 'ready';
		byId('remote-recall-disable').hidden = !recallOnly || !review.hooks.some((h) => h.enabled);
		byId('remote-begin').disabled = false;
	} catch (error) {
		if (request !== reviewRequest || !byId('remote-dialog').open) return;
		byId('remote-recall-status').textContent = message(error);
		byId('remote-begin').disabled = recallOnly;
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
		byId('remote-recall').disabled = !recallReview;
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
	for (const button of all(
		'[data-remote-enable], [data-remote-connect], [data-codex-recall-review]'
	))
		button.addEventListener('click', () => {
			reviewRequest++;
			recallOnly = Object.hasOwn(button.dataset, 'codexRecallReview');
			connectionOnly = Boolean(button.dataset.remoteConnect);
			tool = recallOnly ? 'codex' : (button.dataset.remoteEnable ?? button.dataset.remoteConnect);
			byId('remote-heading').textContent = recallOnly
				? 'Automatic knowledge recall for Codex'
				: connectionOnly
					? tool === 'claude'
						? 'Open Claude remote session (experimental)'
						: 'Get Codex pairing code (experimental)'
					: tool === 'claude'
						? 'Enable Claude Remote Control (experimental)'
						: 'Enable Codex remote (experimental)';
			byId('remote-trust-field').hidden = connectionOnly || recallOnly;
			byId('remote-trust').required = !connectionOnly && !recallOnly;
			byId('remote-begin').textContent = recallOnly
				? 'Save knowledge recall approval'
				: connectionOnly
					? 'Get connection details'
					: 'Continue';
			byId('remote-begin').hidden = false;
			byId('remote-begin').disabled = false;
			byId('remote-advanced').hidden = connectionOnly || recallOnly || tool !== 'codex';
			byId('remote-advanced').open = false;
			byId('remote-sandbox-field').hidden = connectionOnly || recallOnly || tool !== 'codex';
			byId('remote-recall-field').hidden = connectionOnly || tool !== 'codex';
			byId('remote-recall').required = recallOnly;
			byId('remote-sandbox').value =
				state.currentConfig?.assistant.codexSandbox ?? 'workspace-write';
			byId('remote-trust').checked = false;
			byId('remote-stage').textContent = recallOnly
				? 'Review the AKM commands, then save your choice. Remote startup is unchanged.'
				: connectionOnly
					? 'Get fresh private connection details from the running agent.'
					: 'Ready to begin. Existing remote startup is paused during setup.';
			byId('remote-output').value = '';
			byId('remote-prompts').hidden = true;
			byId('remote-output-details').open = false;
			byId('remote-answer-field').hidden = true;
			byId('remote-send').hidden = true;
			byId('remote-guidance').textContent = recallOnly
				? 'Approve only the commands you want Codex to run. No account sign-in is needed for this review.'
				: connectionOnly
					? 'Use these details in a supported client. Do not share pairing codes or links.'
					: 'Sign in through your browser, then approve any account or workspace prompts yourself.';
			for (const item of all('[data-remote-step]'))
				item.setAttribute(
					'aria-current',
					!connectionOnly && item.dataset.remoteStep === 'access' ? 'step' : 'false'
				);
			byId('remote-steps').hidden = connectionOnly || recallOnly;
			byId('remote-answer').value = '';
			byId('remote-send').disabled = true;
			byId('remote-cancel').textContent = 'Cancel';
			byId('remote-dialog').showModal();
			if (!connectionOnly && tool === 'codex') void loadRecall();
		});
	byId('remote-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (running) {
			byId('remote-send').click();
			return;
		}
		if (
			starting ||
			byId('remote-begin').disabled ||
			(!connectionOnly && !recallOnly && !byId('remote-trust').checked) ||
			(recallOnly && !byId('remote-recall').checked)
		)
			return;
		starting = true;
		const recallRequested = byId('remote-recall').checked;
		byId('remote-recall').disabled = true;
		setBusy(true);
		byId('remote-prompts').hidden = recallOnly;
		byId('remote-stage').textContent = 'Preparing Assistant…';
		try {
			if (!connectionOnly && tool === 'codex' && recallRequested) {
				if (!recallReview) throw new Error('Review current AKM hooks first.');
				{
					const review = await state.api.codexRecall({
						action: 'approve',
						digest: recallReview.digest,
						confirmed: true
					});
					if (review.status !== 'ready')
						throw new Error('Native hook approval did not become ready.');
					recallReview = review;
				}
				byId('remote-recall-status').textContent = 'Ready · native approval saved';
			}
			if (
				!connectionOnly &&
				!recallOnly &&
				tool === 'codex' &&
				!recallRequested &&
				recallReview?.status === 'ready'
			) {
				await state.api.codexRecall({
					action: 'disable',
					digest: recallReview.digest,
					confirmed: true
				});
			}
			if (recallOnly) {
				byId('remote-stage').textContent =
					'Knowledge recall is ready for new Codex sessions. No remote connection was enabled.';
				byId('remote-begin').hidden = true;
				byId('remote-recall-disable').hidden = false;
				setBusy(false);
				await refresh(false);
				return;
			}
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
			if (tool === 'codex' && !connectionOnly) {
				byId('remote-recall').checked = false;
				await loadRecall();
			}
		} finally {
			starting = false;
			if (!running) byId('remote-recall').disabled = !recallReview;
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
		reviewRequest++;
		recallReview = undefined;
		byId('remote-answer').value = '';
		byId('remote-output').value = '';
		byId('remote-dialog').close();
	};
	byId('remote-cancel').addEventListener('click', cancel);
	byId('remote-dialog').addEventListener('cancel', (event) => {
		event.preventDefault();
		void cancel();
	});
	byId('remote-recall-disable').addEventListener('click', async () => {
		if (starting || running || !recallOnly || !recallReview) return;
		starting = true;
		setBusy(true);
		try {
			await state.api.codexRecall({
				action: 'disable',
				digest: recallReview.digest,
				confirmed: true
			});
			byId('remote-stage').textContent =
				'Automatic knowledge recall is off. Native approval is retained; remote startup is unchanged.';
			byId('remote-begin').hidden = false;
			await loadRecall();
			await refresh(false);
		} catch (error) {
			byId('remote-stage').textContent = message(error);
			await loadRecall();
		} finally {
			starting = false;
			setBusy(false);
		}
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
