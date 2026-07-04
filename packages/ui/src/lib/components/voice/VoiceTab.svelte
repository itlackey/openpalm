<!--
  Voice settings panel — simplified 3-engine picker.

  For each of TTS and STT the operator picks one of:
    - OpenPalm Voice — reserved slot, disabled until the addon ships.
    - Remote (OpenAI-compatible) — endpoint URL + optional API key + model.
    - Browser — only shown when the relevant Web Speech API is present.

  Saves to PUT /admin/voice. The route validates the selection (rejects
  `openpalm-voice` and rejects `remote` without a baseURL) and the user-facing
  error surfaces in the banner below.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchVoiceConfig, saveVoiceConfig, type VoiceAddonProfile, type VoiceActiveJob } from '$lib/api.js';
	import { notifications } from '$lib/notifications.svelte.js';
	import {
		voiceState,
		setTtsAutoEnabled,
		speakText,
	} from '$lib/voice/voice-state.svelte.js';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import VoiceAddonProfileSection from '$lib/components/voice/VoiceAddonProfileSection.svelte';
	import type { TtsOption, SttOption, VoiceEngineConfig } from '$lib/client/types.js';
	import { pollUntil } from '$lib/poll-until.js';
	import {
		EMPTY_SECTION,
		normalizeEngine,
		readSection,
		buildPayload,
		type EngineId,
		type VoiceSection,
	} from '$lib/components/voice/voice-mappers.js';

	type Availability = {
		stt: { remoteConfigured: boolean; remoteReachable: boolean };
		tts: { remoteConfigured: boolean; remoteReachable: boolean };
	};

	const ADMIN_TTS_OPTIONS: TtsOption[] = [
		{
			id: 'openpalm-voice',
			name: 'OpenPalm Voice',
			type: 'local',
			recommended: true,
			desc: 'Local Kokoro TTS + Whisper STT bundled together.',
		},
		{
			id: 'remote',
			name: 'Remote (OpenAI-compatible)',
			type: 'cloud',
			desc: 'Point at any /v1/audio/speech endpoint (OpenAI, Kokoro, Piper, …).',
		},
		{
			id: 'browser',
			name: 'Browser',
			type: 'builtin',
			desc: 'Web Speech API on this device. No setup, voice quality varies.',
		},
	];

	const ADMIN_STT_OPTIONS: SttOption[] = [
		{
			id: 'openpalm-voice',
			name: 'OpenPalm Voice',
			type: 'local',
			recommended: true,
			desc: 'Local Kokoro TTS + Whisper STT bundled together.',
		},
		{
			id: 'remote',
			name: 'Remote (OpenAI-compatible)',
			type: 'cloud',
			desc: 'Point at any /v1/audio/transcriptions endpoint (Whisper, …).',
		},
		{
			id: 'browser',
			name: 'Browser',
			type: 'builtin',
			desc: 'Web Speech API on this device. Chrome/Edge only on desktop.',
		},
	];

	const ADMIN_TTS_ENGINES: Record<string, VoiceEngineConfig> = {
		'openpalm-voice': { id: 'openpalm-voice', fields: [] },
		remote: {
			id: 'remote',
			fields: [
				{
					key: 'baseURL',
					label: 'Endpoint URL',
					placeholder: 'http://host.docker.internal:8880/v1',
					hint: 'OpenAI-compatible /v1/audio/speech endpoint.',
				},
				{ key: 'model', label: 'Model', placeholder: 'tts-1' },
				{ key: 'voice', label: 'Voice', placeholder: 'alloy' },
			],
		},
		browser: { id: 'browser', fields: [] },
	};

	const ADMIN_STT_ENGINES: Record<string, VoiceEngineConfig> = {
		'openpalm-voice': { id: 'openpalm-voice', fields: [] },
		remote: {
			id: 'remote',
			fields: [
				{
					key: 'baseURL',
					label: 'Endpoint URL',
					placeholder: 'http://host.docker.internal:9000/v1',
					hint: 'OpenAI-compatible /v1/audio/transcriptions endpoint.',
				},
				{ key: 'model', label: 'Model', placeholder: 'whisper-1' },
				{
					key: 'language',
					label: 'Language',
					placeholder: 'en',
					hint: 'A code like `en` or `fr`, or leave blank to detect.',
				},
			],
		},
		browser: {
			id: 'browser',
			fields: [{ key: 'language', label: 'Language', placeholder: 'en-US' }],
		},
	};

	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');

	let tts = $state<VoiceSection>(EMPTY_SECTION());
	let stt = $state<VoiceSection>(EMPTY_SECTION());
	let availability = $state<Availability>({
		stt: { remoteConfigured: false, remoteReachable: false },
		tts: { remoteConfigured: false, remoteReachable: false },
	});
	let addonProfiles = $state<VoiceAddonProfile[]>([]);
	let selectedProfile = $state<string>('');
	const wantsOpenpalmVoice = $derived(
		tts.engine === 'openpalm-voice' || stt.engine === 'openpalm-voice',
	);

	// Browser Web Speech availability — probed once on mount.
	let browserSttAvailable = $state(false);
	let browserTtsAvailable = $state(false);

	// "Test voice" button state — tied to the same speakText pipeline the
	// chat page uses, so a green ✓ here means it'll work in chat too.
	let testingVoice = $state(false);
	let testResult = $state<'success' | 'error' | null>(null);
	let testError = $state('');

	// Browser STT availability — used to disable/hide browser options
	const browserSttDisabled = $derived(
		browserSttAvailable && !!voiceState.browserSttUnsupportedReason
	);
	const browserSttDisabledReason = $derived(voiceState.browserSttUnsupportedReason ?? '');

	function updateSttField(key: string, val: string): void {
		if (key === 'baseURL') stt.baseURL = val;
		else if (key === 'model') stt.model = val;
		else if (key === 'language') stt.language = val;
	}

	function updateTtsField(key: string, val: string): void {
		if (key === 'baseURL') tts.baseURL = val;
		else if (key === 'model') tts.model = val;
		else if (key === 'voice') tts.voice = val;
	}

	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const res = await fetchVoiceConfig();
			tts = readSection(res.tts as Record<string, unknown> | undefined, 'tts');
			stt = readSection(res.stt as Record<string, unknown> | undefined, 'stt');
			const a = (res as { availability?: Availability }).availability;
			if (a) availability = a;
			if (res.addon) {
				addonProfiles = res.addon.profiles ?? [];
				const isAvailable = (p: VoiceAddonProfile | undefined): boolean =>
					!!p && p.available !== false;
				const cpuProfileId = 'addon.voice.cpu';
				const serverSelected = res.addon.selectedProfile ?? '';
				const serverSelectedProfile = addonProfiles.find((p) => p.id === serverSelected);
				if (isAvailable(serverSelectedProfile)) {
					selectedProfile = serverSelected;
				} else {
					// Server-recorded profile isn't actually runnable on this
					// host (driver missing / new hardware). Fall back to CPU
					// (or first available) and warn the operator.
					const fallback =
						addonProfiles.find((p) => p.id === cpuProfileId && isAvailable(p))
						?? addonProfiles.find((p) => p.default && isAvailable(p))
						?? addonProfiles.find((p) => isAvailable(p));
					selectedProfile = fallback?.id ?? '';
					if (serverSelectedProfile && fallback && serverSelected !== fallback.id) {
						notifications.push(
							'info',
							`"${serverSelectedProfile.label ?? serverSelected}" profile isn't available on this host${serverSelectedProfile.reason ? ` (${serverSelectedProfile.reason})` : ''}. Using "${fallback.label ?? fallback.id}" instead.`,
						);
					}
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load voice settings.';
		} finally {
			loading = false;
		}
	}

	async function save(): Promise<void> {
		saving = true;
		error = '';

		const wantsVoiceAddon =
			tts.engine === 'openpalm-voice' || stt.engine === 'openpalm-voice';

		// Sticky in-progress toast that we update in-place as the route
		// works through its steps. Pre-emptive — even if the addon was
		// already running, the operator gets one beat of feedback so the
		// click feels acknowledged.
		let progressToastId: string | null = null;
		let bumpTimer: ReturnType<typeof setTimeout> | null = null;
		if (wantsVoiceAddon) {
			progressToastId = notifications.push('info', 'Enabling voice addon…', { sticky: true });
			// If the server takes longer than the visible blink of an
			// "Enabling…" message, bump the toast to the "may take a
			// moment" variant so the user doesn't think we're stuck.
			bumpTimer = setTimeout(() => {
				if (progressToastId) {
					notifications.push('info', 'Starting voice addon — this may take a moment…', {
						sticky: true,
						replaceId: progressToastId,
					});
				}
			}, 1500);
		}

		try {
			const result = await saveVoiceConfig({
				tts: buildPayload(tts, 'tts'),
				stt: buildPayload(stt, 'stt'),
				...(wantsOpenpalmVoice && selectedProfile ? { profile: selectedProfile } : {}),
			});

			if (bumpTimer) {
				clearTimeout(bumpTimer);
				bumpTimer = null;
			}

			if (wantsVoiceAddon && progressToastId) {
				const va = result.voiceAddon;
				if (result.status === 202 && va) {
					// Background pull kicked off. Switch the sticky toast to
					// the "downloading" copy and start polling /admin/voice
					// for completion.
					notifications.push(
						'info',
						va.message ?? 'Voice image is downloading — this can take several minutes.',
						{ sticky: true, replaceId: progressToastId },
					);
					void pollUntilVoiceJobFinishes(progressToastId);
					progressToastId = null;
				} else if (result.ok && va) {
					// Healthy. Replace the sticky "enabling" toast with a
					// friendly success message that auto-dismisses.
					notifications.push(
						'success',
						va.wasAlreadyEnabled
							? "Voice addon ready — let's chat!"
							: "Voice addon started, let's chat!",
						{ replaceId: progressToastId },
					);
				} else if (va) {
					// Server-side flow saw a step fail (compose pull, container
					// start, healthcheck timeout). The error string is already
					// human-readable.
					notifications.push('error', va.error ?? 'Voice addon failed to start.', {
						replaceId: progressToastId,
					});
				} else {
					// 200 but no voiceAddon block — shouldn't happen for an
					// openpalm-voice save, but be defensive.
					notifications.push('success', 'Voice settings saved.', { replaceId: progressToastId });
				}
			}

			if (!wantsVoiceAddon) {
				notifications.push('success', 'Voice settings saved.');
			}
			// Refresh availability after saving — the URL may have changed.
			await load();
		} catch (e) {
			if (bumpTimer) {
				clearTimeout(bumpTimer);
			}
			const msg = e instanceof Error ? e.message : 'Failed to save voice settings.';
			error = msg;
			if (progressToastId) {
				notifications.push('error', msg, { replaceId: progressToastId });
			} else if (wantsVoiceAddon) {
				notifications.push('error', msg);
			}
		} finally {
			saving = false;
		}
	}

	/**
	 * Background voice-job poll. The PUT returned 202 (image is being
	 * pulled in the background); we now poll GET /admin/voice every 3s,
	 * watching `addon.activeJob.state` until it flips to healthy or
	 * error. Caps at 30 minutes; gives the operator one last toast at
	 * the timeout cap regardless. The sticky toast id is passed in so we
	 * update the SAME toast — no spammy duplicates.
	 */
	async function pollUntilVoiceJobFinishes(stickyToastId: string): Promise<void> {
		const POLL_INTERVAL_MS = 3_000;
		const POLL_DEADLINE_MS = 30 * 60_000;
		// `undefined` = network blip (keep polling); `null` = job disappeared
		// (server retention expired → treat as success); otherwise the job.
		type PollValue = VoiceActiveJob | null | undefined;
		let lastState: string = 'pulling';

		const outcome = await pollUntil<PollValue>(
			async () => {
				try {
					return (await fetchVoiceConfig()).addon?.activeJob ?? null;
				} catch {
					// Network blip / 401. Don't spam; just retry next tick.
					return undefined;
				}
			},
			(job) => {
				if (job === undefined) return false; // blip → keep polling
				if (job === null) return true; // disappeared → terminal (success)
				if (job.state === 'healthy' || job.state === 'error') return true;
				// Still pulling/starting. Update copy on state transition only
				// so the toast doesn't churn.
				if (job.state !== lastState) {
					lastState = job.state;
					const message =
						job.state === 'starting'
							? 'Voice container started — warming up models…'
							: 'Voice image still downloading…';
					notifications.push('info', message, { sticky: true, replaceId: stickyToastId });
				}
				return false;
			},
			{ intervalMs: POLL_INTERVAL_MS, deadlineMs: POLL_DEADLINE_MS },
		);

		if (outcome.timedOut) {
			notifications.push(
				'error',
				'Voice addon is taking longer than 30 minutes. Check Docker logs for openpalm-voice.',
				{ replaceId: stickyToastId },
			);
		} else if (!outcome.value || outcome.value.state === 'healthy') {
			// null (disappeared) or healthy → the addon is ready.
			notifications.push('success', "Voice addon ready — let's chat!", {
				replaceId: stickyToastId,
			});
		} else {
			// state === 'error'
			notifications.push('error', outcome.value.error ?? 'Voice addon failed to start.', {
				replaceId: stickyToastId,
			});
		}
		await load();
	}

	/**
	 * "Test voice" — uses the same speakText path the chat page uses so a
	 * green ✓ here means assistant replies will play. We watch voiceState
	 * for the transition out of 'speaking' to know it finished, and check
	 * errorMessage at the start to detect autoplay/transport failures.
	 */
	async function runVoiceTest(): Promise<void> {
		if (testingVoice) return;
		testingVoice = true;
		testResult = null;
		testError = '';
		try {
			// speakText sets voiceState.errorMessage on failure paths
			// (autoplay block, 5xx upstream, no-fallback). Clear it first so
			// we can detect a fresh failure.
			voiceState.errorMessage = '';
			await speakText('Hello! Your voice is working.');
			// speakText returns once the audio.play() promise resolves OR
			// rejects (then it sets errorMessage). If errorMessage is set,
			// surface that as the test failure.
			if (voiceState.errorMessage) {
				testResult = 'error';
				testError = voiceState.errorMessage;
			} else {
				testResult = 'success';
			}
		} catch (e) {
			testResult = 'error';
			testError = e instanceof Error ? e.message : 'Voice test failed.';
		} finally {
			testingVoice = false;
			// Auto-clear the ✓/✗ badge after a few seconds.
			setTimeout(() => { testResult = null; testError = ''; }, 5000);
		}
	}

	onMount(() => {
		// Probe Web Speech APIs (client-only).
		browserSttAvailable = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
		browserTtsAvailable = 'speechSynthesis' in window;
		void load();
	});
</script>

<div class="panel" role="tabpanel">
	<div class="panel-header">
		<div>
			<h2>Voice</h2>
			<p class="panel-subtitle">Speech-to-text · text-to-speech</p>
		</div>
		<div class="panel-header-actions">
			<button class="btn btn-secondary btn-sm" onclick={() => void load()} disabled={loading || saving}>
				{#if loading}<Spinner size={12} />{/if}
				Refresh
			</button>
			<button class="btn btn-primary btn-sm" onclick={() => void save()} disabled={loading || saving}>
				{#if saving}<Spinner size={12} />{/if}
				Save
			</button>
		</div>
	</div>

	{#if error}<div class="error-banner"><span>{error}</span></div>{/if}

	<div class="panel-body">
		<div class="voice-grid">
			<!-- ── STT (left) ───────────────────────────────────── -->
			<div class="section-card">
				<div class="sc-title">Speech-to-text (STT)</div>

				<div class="field">
					<label class="field-label" for="stt-engine">Engine</label>
					<select
						id="stt-engine"
						class="field-select"
						value={stt.engine}
						onchange={(e) => { stt.engine = (e.currentTarget as HTMLSelectElement).value as EngineId | ''; }}
						disabled={loading || saving}
					>
						<option value="">— select engine —</option>
						{#each ADMIN_STT_OPTIONS as o (o.id)}
							{#if browserSttAvailable || o.id !== 'browser'}
								<option value={o.id} disabled={o.id === 'browser' && browserSttDisabled}>{o.name}</option>
							{/if}
						{/each}
					</select>
					{#if stt.engine === 'remote' && availability.stt.remoteConfigured}
						<span class="reachability" class:reachability--ok={availability.stt.remoteReachable}>
							{availability.stt.remoteReachable ? '● Endpoint reachable' : '○ Endpoint not reachable'}
						</span>
					{/if}
				</div>

				{#if stt.engine}
					{#each ADMIN_STT_ENGINES[stt.engine]?.fields ?? [] as field (field.key)}
						<div class="field">
							<label class="field-label" for="stt-{field.key}">{field.label}</label>
							<input
								id="stt-{field.key}"
								type={field.key === 'baseURL' ? 'url' : 'text'}
								class="field-input"
								placeholder={field.placeholder ?? ''}
								value={field.key === 'baseURL' ? stt.baseURL : field.key === 'model' ? stt.model : stt.language}
								oninput={(e) => updateSttField(field.key, (e.currentTarget as HTMLInputElement).value)}
								disabled={loading || saving}
								autocomplete="off"
							/>
							{#if field.hint}<p class="field-hint">{field.hint}</p>{/if}
						</div>
					{/each}
					{#if stt.engine === 'browser' && browserSttDisabled}
						<p class="field-hint field-hint--warn">{browserSttDisabledReason}</p>
					{/if}
				{/if}
			</div>

			<!-- ── TTS (right) ──────────────────────────────────── -->
			<div class="section-card">
				<div class="sc-title">Text-to-speech (TTS)</div>

				<div class="field">
					<label class="field-label" for="tts-engine">Engine</label>
					<select
						id="tts-engine"
						class="field-select"
						value={tts.engine}
						onchange={(e) => { tts.engine = (e.currentTarget as HTMLSelectElement).value as EngineId | ''; }}
						disabled={loading || saving}
					>
						<option value="">— select engine —</option>
						{#each ADMIN_TTS_OPTIONS as o (o.id)}
							{#if browserTtsAvailable || o.id !== 'browser'}
								<option value={o.id}>{o.name}</option>
							{/if}
						{/each}
					</select>
					{#if tts.engine === 'remote' && availability.tts.remoteConfigured}
						<span class="reachability" class:reachability--ok={availability.tts.remoteReachable}>
							{availability.tts.remoteReachable ? '● Endpoint reachable' : '○ Endpoint not reachable'}
						</span>
					{/if}
				</div>

				{#if tts.engine}
					{#each ADMIN_TTS_ENGINES[tts.engine]?.fields ?? [] as field (field.key)}
						<div class="field">
							<label class="field-label" for="tts-{field.key}">{field.label}</label>
							<input
								id="tts-{field.key}"
								type={field.key === 'baseURL' ? 'url' : 'text'}
								class="field-input"
								placeholder={field.placeholder ?? ''}
								value={field.key === 'baseURL' ? tts.baseURL : field.key === 'model' ? tts.model : tts.voice}
								oninput={(e) => updateTtsField(field.key, (e.currentTarget as HTMLInputElement).value)}
								disabled={loading || saving}
								autocomplete="off"
							/>
							{#if field.hint}<p class="field-hint">{field.hint}</p>{/if}
						</div>
					{/each}
				{/if}

				<div class="sc-foot">
					<div class="test-row">
						<button
							type="button"
							class="btn btn-secondary btn-sm"
							onclick={() => void runVoiceTest()}
							disabled={testingVoice || saving || loading || !tts.engine}
						>
							{#if testingVoice}<Spinner size={12} />{/if}
							Test speaker
						</button>
						{#if testResult === 'success'}
							<span class="test-ok">✓ Working</span>
						{:else if testResult === 'error'}
							<span class="test-err">{testError || 'Failed'}</span>
						{/if}
					</div>
					<label class="auto-speak-toggle">
						<input
							type="checkbox"
							checked={voiceState.ttsAutoEnabled}
							onchange={(e) => setTtsAutoEnabled((e.currentTarget as HTMLInputElement).checked)}
						/>
						<span>Speak replies automatically</span>
					</label>
				</div>
			</div>
		</div>

		{#if wantsOpenpalmVoice && addonProfiles.length > 0}
			<VoiceAddonProfileSection
				profiles={addonProfiles}
				{selectedProfile}
				onchange={(id) => selectedProfile = id}
			/>
		{/if}
	</div>
</div>

<style>
	.panel-body { display: flex; flex-direction: column; gap: var(--s-sp-6); }

	.voice-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--s-sp-5);
	}

	.section-card {
		border: var(--s-hair) solid var(--s-line-soft);
		border-radius: 2px;
		padding: var(--s-sp-5);
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-4);
	}

	.sc-title {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		border-bottom: var(--s-hair) solid var(--s-line-soft);
		padding-bottom: var(--s-sp-3);
	}

	.field { display: flex; flex-direction: column; gap: var(--s-sp-2); }

	.field-label {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
	}

	.field-select, .field-input {
		border: var(--s-hair) solid var(--s-line);
		border-radius: 2px;
		background: none;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-2);
		padding: 0.4em 0.6em;
		width: 100%;
	}
	.field-select:focus, .field-input:focus {
		outline: none;
		border-color: var(--s-seal);
	}

	.field-hint {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-3);
		margin: 0;
	}
	.field-hint--warn { color: var(--s-seal); }

	.reachability {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-3);
	}
	.reachability--ok { color: var(--s-moss); }

	.sc-foot {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-3);
		margin-top: auto;
		padding-top: var(--s-sp-3);
		border-top: var(--s-hair) solid var(--s-line-soft);
	}

	.test-row { display: flex; align-items: center; gap: var(--s-sp-3); flex-wrap: wrap; }

	.test-ok {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-moss);
	}
	.test-err {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-seal);
	}

	.auto-speak-toggle {
		display: flex; align-items: center; gap: var(--s-sp-2);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-2);
		cursor: pointer;
	}
	.auto-speak-toggle input[type='checkbox'] {
		appearance: none;
		width: 1rem; height: 1rem;
		border: var(--s-hair) solid var(--s-line);
		border-radius: 2px;
		background: none;
		flex-shrink: 0;
		position: relative;
		cursor: pointer;
	}
	.auto-speak-toggle input[type='checkbox']:checked {
		background: var(--s-seal);
		border-color: var(--s-seal);
	}
	.auto-speak-toggle input[type='checkbox']:checked::after {
		content: '';
		position: absolute; left: 2px; top: 1px;
		width: 8px; height: 5px;
		border: 1.4px solid white; border-top: 0; border-right: 0;
		transform: rotate(-45deg);
	}

	.error-banner {
		display: flex; align-items: center; gap: var(--s-sp-2);
		padding: var(--s-sp-3) var(--s-sp-4);
		border: var(--s-hair) solid var(--s-seal);
		border-radius: 2px;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-seal);
	}

	@media (max-width: 640px) {
		.voice-grid { grid-template-columns: 1fr; }
	}
</style>
