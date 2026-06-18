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
	import { fetchVoiceConfig, saveVoiceConfig, type VoiceAddonProfile } from '$lib/api.js';
	import { notifications } from '$lib/notifications.svelte.js';
	import {
		voiceState,
		setTtsAutoEnabled,
		speakText,
	} from '$lib/voice/voice-state.svelte.js';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import VoiceTtsSection from '$lib/components/voice/VoiceTtsSection.svelte';
	import VoiceSttSection from '$lib/components/voice/VoiceSttSection.svelte';
	import VoiceAddonProfileSection from '$lib/components/voice/VoiceAddonProfileSection.svelte';
	import type {
		SttOption,
		TtsOption,
		VoiceEngineConfig,
		VoiceEngineValue,
	} from '$lib/client/types.js';

	interface Props { tokenStored: boolean; }
	let { tokenStored }: Props = $props();

	type EngineId = 'openpalm-voice' | 'remote' | 'browser';

	type VoiceSection = {
		engine: EngineId | '';
		baseURL: string;
		model: string;
		voice: string; // tts only
		language: string; // stt only
	};

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

	const EMPTY_SECTION = (): VoiceSection => ({ engine: '', baseURL: '', model: '', voice: '', language: '' });

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

	// Convert VoiceSection ↔ VoiceEngineValue for the shared component
	function sectionToValue(s: VoiceSection): VoiceEngineValue {
		return {
			engine: s.engine,
			...(s.baseURL ? { baseURL: s.baseURL } : {}),
			...(s.model ? { model: s.model } : {}),
			...(s.voice ? { voice: s.voice } : {}),
			...(s.language ? { language: s.language } : {}),
		};
	}

	function applyTtsChange(v: VoiceEngineValue): void {
		tts.engine = (v.engine || '') as EngineId | '';
		tts.baseURL = v.baseURL ?? '';
		tts.model = v.model ?? '';
		tts.voice = v.voice ?? '';
	}

	function applySttChange(v: VoiceEngineValue): void {
		stt.engine = (v.engine || '') as EngineId | '';
		stt.baseURL = v.baseURL ?? '';
		stt.model = v.model ?? '';
		stt.language = v.language ?? '';
	}

	// Browser STT disabled state for the shared component
	const sttDisabledEngines = $derived.by(() => {
		const map: Record<string, { disabled: boolean; reason?: string }> = {};
		if (browserSttAvailable && voiceState.browserSttUnsupportedReason) {
			map['browser'] = { disabled: true, reason: voiceState.browserSttUnsupportedReason };
		}
		return map;
	});

	const ttsHiddenEngines = $derived(
		browserTtsAvailable ? undefined : new Set(['browser']),
	);
	const sttHiddenEngines = $derived(
		!browserSttAvailable ? new Set(['browser']) : undefined,
	);

	function normalizeEngine(raw: unknown, kind: 'tts' | 'stt'): EngineId | '' {
		if (typeof raw !== 'string') return '';
		if (raw === 'openpalm-voice') return 'openpalm-voice';
		if (raw === 'browser' || raw === (kind === 'tts' ? 'browser-tts' : 'browser-stt')) return 'browser';
		if (!raw || raw.startsWith('skip-')) return '';
		// Anything else (kokoro, openai-tts, whisper-local, openai-stt, …) is treated as remote.
		return 'remote';
	}

	function readSection(raw: Record<string, unknown> | undefined, kind: 'tts' | 'stt'): VoiceSection {
		const s = EMPTY_SECTION();
		if (!raw || typeof raw !== 'object') return s;
		s.engine = normalizeEngine(raw.engine, kind);
		if (typeof raw.baseURL === 'string') s.baseURL = raw.baseURL;
		if (typeof raw.model === 'string') s.model = raw.model;
		if (kind === 'tts' && typeof raw.voice === 'string') s.voice = raw.voice;
		if (kind === 'stt' && typeof raw.language === 'string') s.language = raw.language;
		return s;
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

	function buildPayload(section: VoiceSection, kind: 'tts' | 'stt'): Record<string, unknown> | undefined {
		if (!section.engine) return undefined;
		const out: Record<string, unknown> = { enabled: true, engine: section.engine };
		if (section.engine === 'remote') {
			if (section.baseURL) out.baseURL = section.baseURL;
			if (section.model) out.model = section.model;
			if (kind === 'tts' && section.voice) out.voice = section.voice;
			if (kind === 'stt' && section.language) out.language = section.language;
		} else if (section.engine === 'browser' && kind === 'stt' && section.language) {
			out.language = section.language;
		}
		return out;
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
				bumpTimer = null;
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
		const deadline = Date.now() + POLL_DEADLINE_MS;
		let lastState: string = 'pulling';
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
			try {
				const cfg = await fetchVoiceConfig();
				const job = cfg.addon?.activeJob;
				if (!job) {
					// Job disappeared (server retention expired). Treat as
					// success — the addon probably finished healthy and aged out.
					notifications.push('success', "Voice addon ready — let's chat!", {
						replaceId: stickyToastId,
					});
					await load();
					return;
				}
				if (job.state === 'healthy') {
					notifications.push('success', "Voice addon ready — let's chat!", {
						replaceId: stickyToastId,
					});
					await load();
					return;
				}
				if (job.state === 'error') {
					notifications.push(
						'error',
						job.error ?? 'Voice addon failed to start.',
						{ replaceId: stickyToastId },
					);
					await load();
					return;
				}
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
			} catch {
				// Network blip / 401. Don't spam; just retry next tick.
			}
		}
		notifications.push(
			'error',
			'Voice addon is taking longer than 30 minutes. Check Docker logs for openpalm-voice.',
			{ replaceId: stickyToastId },
		);
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
		if (tokenStored) void load();
	});
</script>

<div class="panel" role="tabpanel">
	<div class="panel-header">
		<h2>Voice</h2>
		<div class="panel-header-actions">
			<button class="btn btn-secondary btn-sm" onclick={() => void load()} disabled={loading || saving || !tokenStored}>
				{#if loading}<Spinner size={12} />{/if}
				Refresh
			</button>
			<button class="btn btn-primary btn-sm" onclick={() => void save()} disabled={loading || saving || !tokenStored}>
				{#if saving}<Spinner size={12} />{/if}
				Save
			</button>
		</div>
	</div>

	{#if error}<div class="error-banner"><span>{error}</span></div>{/if}

	<div class="panel-body">
		<p class="section-desc">
			Configure how the assistant listens and speaks. Choose an engine for each;
			the in-app mic uses STT and the optional auto-speak toggle uses TTS.
		</p>

		<VoiceTtsSection
			value={sectionToValue(tts)}
			onchange={applyTtsChange}
			engineOptions={ADMIN_TTS_OPTIONS}
			engineConfigs={ADMIN_TTS_ENGINES}
			reachable={availability.tts}
			hiddenEngines={ttsHiddenEngines}
			engineSelected={!!tts.engine}
			ttsAutoEnabled={voiceState.ttsAutoEnabled}
			onAutoEnabledChange={(checked) => setTtsAutoEnabled(checked)}
			{testingVoice}
			{testResult}
			{testError}
			onTest={() => void runVoiceTest()}
			busy={saving || loading}
		/>

		<VoiceSttSection
			value={sectionToValue(stt)}
			onchange={applySttChange}
			engineOptions={ADMIN_STT_OPTIONS}
			engineConfigs={ADMIN_STT_ENGINES}
			reachable={availability.stt}
			disabledEngines={sttDisabledEngines}
			hiddenEngines={sttHiddenEngines}
		/>

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
	.panel-header {
		position: sticky; top: 0; z-index: 10;
		background: var(--s-paper);
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--s-sp-4) var(--s-sp-5);
		border-bottom: var(--s-hair) solid var(--s-line-soft);
		margin-bottom: 0;
	}
	.panel-header h2 {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-deed);
		font-weight: 400;
		text-transform: uppercase;
		letter-spacing: var(--s-track-label);
		color: var(--s-ink);
		margin: 0;
	}
	.panel-header-actions { display: flex; gap: var(--s-sp-2); }
	.panel-body { display: flex; flex-direction: column; gap: var(--s-sp-6); }
	.section-desc {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-2);
		margin: 0;
	}
	.error-banner {
		display: flex; align-items: center; gap: var(--s-sp-2);
		padding: var(--s-sp-3) var(--s-sp-4);
		background: none;
		border: var(--s-hair) solid var(--s-seal);
		border-radius: 2px;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-seal);
		margin-bottom: var(--s-sp-4);
	}
</style>
