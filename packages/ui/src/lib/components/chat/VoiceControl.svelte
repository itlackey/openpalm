<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		voiceState,
		initVoice,
		destroyVoice,
		startListening,
		stopListening,
		stopSpeaking,
		setTtsAutoEnabled,
		resumeAutoplay,
	} from '$lib/voice/voice-state.svelte.js';
	import IconMic from '@openpalm/ui-kit/components/icons/IconMic.svelte';
	import IconMicOff from '@openpalm/ui-kit/components/icons/IconMicOff.svelte';
	import IconSoundOff from '@openpalm/ui-kit/components/icons/IconSoundOff.svelte';
	import IconSoundOn from '@openpalm/ui-kit/components/icons/IconSoundOn.svelte';
	import IconStop from '@openpalm/ui-kit/components/icons/IconStop.svelte';

	const MAX_INTERIM_CHARS = 48;
	import { chat } from '$lib/chat/chat-state.svelte.js';

	type OpenPalmBridge = {
		setTrayMicRecording?: (recording: boolean) => Promise<void>;
		onGlobalMicToggle?: (callback: () => void) => (() => void) | void;
		requestMicPermission?: () => Promise<string>;
	};

	let mounted = $state(false);
	let removeGlobalMicToggle: (() => void) | null = null;

	onMount(() => {
		void initVoice().then(() => {
			mounted = true;
		});

		const openpalm = (window as Window & { openpalm?: OpenPalmBridge }).openpalm;
		removeGlobalMicToggle = openpalm?.onGlobalMicToggle?.(() => { handleMicClick(); }) ?? null;
	});

	onDestroy(() => {
		// onDestroy runs on the server during SSR — guard window access or it throws 500.
		if (typeof window !== 'undefined') {
			void (window as Window & { openpalm?: OpenPalmBridge }).openpalm?.setTrayMicRecording?.(false);
		}
		removeGlobalMicToggle?.();
		removeGlobalMicToggle = null;
		destroyVoice();
	});

	// Mic only renders when a usable STT engine is configured AND available
	// in this browser. (e.g. don't render "browser" mic on Firefox.)
	let supported = $derived(
		mounted && voiceState.sttEngine !== 'disabled' && voiceState.sttSupported
	);
	let ttsAvailable = $derived(mounted && voiceState.ttsSupported);

	// Mic states (mutually exclusive, evaluated in priority order):
	//   recording — actively capturing audio
	//   transcribing — recorded audio is being sent to /api/transcribe
	//   processing — message in flight to the assistant
	//   idle — neutral
	let isRecording = $derived(voiceState.status === 'recording');
	let isTranscribing = $derived(voiceState.status === 'transcribing');
	let isProcessing = $derived(!isRecording && !isTranscribing && chat.sending);

	// Speaker is "speaking" only when the auto-TTS is on AND an utterance is
	// currently playing. With the toggle off, the speechSynthesis queue
	// shouldn't be active.
	let isSpeaking = $derived(voiceState.status === 'speaking');

	/**
	 * Mic: always captures. The transcript is submitted straight to the
	 * global chat service, which posts to the currently selected OpenCode
	 * backend. Works from any page because `chat` is a singleton and the
	 * Navbar (containing this component) is mounted everywhere.
	 */
	async function handleMicClick(): Promise<void> {
		if (isProcessing) return;
		if (isRecording) {
			stopListening();
			void (window as Window & { openpalm?: OpenPalmBridge }).openpalm?.setTrayMicRecording?.(false);
			return;
		}
		if (isTranscribing) {
			// Mid-transcription click is a no-op (the result is pending).
			return;
		}
		// If TTS is mid-utterance, stop it so we don't hear ourselves over
		// the assistant's previous response.
		stopSpeaking();

		// On macOS inside Electron, setPermissionRequestHandler granting 'media'
		// is necessary but NOT sufficient — macOS TCC must also grant audio access.
		// Without askForMediaAccess(), the stream is silently empty (TCC never
		// asked), and Whisper transcribes silence as "You". Call the IPC shim so
		// the main process triggers the OS dialog on first click; subsequent calls
		// return 'granted' instantly from TCC's cache.
		const openpalm = (window as Window & { openpalm?: OpenPalmBridge }).openpalm;
		if (openpalm?.requestMicPermission) {
			const status = await openpalm.requestMicPermission();
			if (status === 'denied-no-prompt') {
				// macOS denied without ever showing a prompt — the app build is
				// missing the audio-input entitlement, so OpenPalm will NOT appear
				// in the Settings list. Telling the user to enable it there is
				// impossible to follow; the only fix is an updated build.
				voiceState.errorMessage =
					'This OpenPalm build cannot request microphone access on macOS. Please update to the latest version of the desktop app.';
				return;
			}
			if (status === 'denied' || status === 'restricted') {
				// Main process opened System Settings → Privacy & Security →
				// Microphone for us; the app is in the list with the toggle off.
				voiceState.errorMessage =
					'Microphone access is turned off. In the System Settings window that just opened, enable OpenPalm under Microphone, then quit and reopen the app.';
				return;
			}
		}

		void (window as Window & { openpalm?: OpenPalmBridge }).openpalm?.setTrayMicRecording?.(true);
		startListening((transcript: string) => {
			const trimmed = transcript.trim();
			if (!trimmed) return;
			void chat.send(trimmed);
		});
	}

	/**
	 * Speaker: global toggle for auto-TTS of assistant replies.
	 * Pressed state = auto-TTS is on. State persists to localStorage.
	 */
	function handleSpeakerClick(): void {
		setTtsAutoEnabled(!voiceState.ttsAutoEnabled);
	}
</script>

<!-- Always rendered so the mic (and speaker, when available) are visible on every
     page. When STT is unavailable the mic shows a disabled mic-off icon rather
     than vanishing. -->
<div class="voice-control" role="toolbar" aria-label="Voice controls">
		{#if isRecording && voiceState.interimTranscript}
			<span class="voice-interim" aria-hidden="true" title={voiceState.interimTranscript}>
				{voiceState.interimTranscript.length > MAX_INTERIM_CHARS
					? voiceState.interimTranscript.slice(0, MAX_INTERIM_CHARS) + '…'
					: voiceState.interimTranscript}
			</span>
		{/if}
		{#if voiceState.autoplayBlocked}
			<!-- Scoped autoplay-resume button. Only THIS click triggers
			     playback — we no longer listen on `document`, so Save
			     buttons, tabs, and accidental clicks elsewhere can't fire
			     stale audio. -->
			<button
				type="button"
				class="voice-autoplay-banner"
				onclick={() => resumeAutoplay()}
				aria-label="Resume paused audio"
				title="Audio was blocked by the browser. Click to resume."
			>
				<IconSoundOff size={14} />
				<span>Audio paused — click to resume</span>
			</button>
		{/if}
		{#if ttsAvailable}
			<button
				class="voice-btn"
				class:voice-btn-on={voiceState.ttsAutoEnabled}
				class:voice-btn-speaking={isSpeaking}
				onclick={handleSpeakerClick}
				aria-label={voiceState.ttsAutoEnabled
					? 'Turn off spoken responses'
					: 'Turn on spoken responses'}
				aria-pressed={voiceState.ttsAutoEnabled}
				title={isSpeaking
					? 'Speaking — click to turn off spoken responses'
					: voiceState.ttsAutoEnabled
						? 'Spoken responses are on — click to turn off'
						: 'Spoken responses are off — click to turn on'}
			>
				{#if voiceState.ttsAutoEnabled}
					<IconSoundOn size={16} />
				{:else}
					<IconSoundOff size={16} />
				{/if}
			</button>
		{/if}

		<button
			class="voice-btn"
			class:voice-btn-active={isRecording}
			class:voice-btn-processing={isProcessing || isTranscribing}
			class:voice-btn-disabled={!supported}
			disabled={!supported || isProcessing}
			onclick={handleMicClick}
			aria-label={!supported
				? 'Voice input unavailable'
				: isRecording
					? 'Stop recording'
					: isTranscribing
						? 'Transcribing…'
						: isProcessing
							? 'Sending message…'
							: 'Start recording'}
			aria-pressed={isRecording}
			title={!supported
				? 'Voice input is unavailable — no speech-to-text engine is configured for this browser'
				: isRecording
					? 'Stop recording'
					: isTranscribing
						? 'Transcribing…'
						: isProcessing
							? 'Sending message…'
							: 'Speak — message will be sent to the selected assistant'}
		>
			{#if !supported}
				<!-- mic-off: STT unavailable -->
				<IconMicOff size={16} />
			{:else if isTranscribing || isProcessing}
				<!-- Spinner while audio is being transcribed or the message is in flight -->
				<span class="voice-spinner" aria-hidden="true"></span>
			{:else if isRecording}
				<!-- Stop-square: clicking again ends the recording -->
				<IconStop size={14} />
				<span class="voice-pulse" aria-hidden="true"></span>
			{:else}
				<!-- Idle mic -->
				<IconMic size={16} />
			{/if}
		</button>

		<!-- Errors surface via the global <Toast> in the root layout. Keeping
		     them out of the navbar prevents a long message from causing the
		     navbar to overflow horizontally on narrow widths. -->

		<span class="sr-only" aria-live="polite">
			{isRecording && voiceState.interimTranscript
				? voiceState.interimTranscript
				: isRecording
				? 'Recording'
				: isTranscribing
					? 'Transcribing'
					: isProcessing
						? 'Sending message to assistant'
						: isSpeaking
							? 'Assistant is speaking'
							: voiceState.ttsAutoEnabled
								? 'Spoken responses on'
								: ''}
		</span>
	</div>

<style>
	.voice-control {
		display: flex;
		align-items: center;
		gap: var(--s-sp-2);
	}

	/* Interim transcript chip — mono, muted */
	.voice-interim {
		max-width: 200px;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 2px var(--s-sp-2);
		background: none;
		border: var(--s-hair) solid var(--s-line-soft);
		border-radius: 2px;
		flex-shrink: 1;
		min-width: 0;
	}

	/* Autoplay resume banner */
	.voice-autoplay-banner {
		display: inline-flex;
		align-items: center;
		gap: var(--s-sp-2);
		padding: 4px var(--s-sp-3);
		height: 28px;
		background: none;
		border: var(--s-hair) solid var(--s-line);
		border-radius: 2px;
		color: var(--s-ink-3);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		cursor: pointer;
		white-space: nowrap;
		transition: color 120ms ease, border-color 120ms ease;
	}
	.voice-autoplay-banner:hover {
		color: var(--s-ink-2);
		border-color: var(--s-line);
	}
	.voice-autoplay-banner:focus-visible {
		outline: var(--s-hair) solid var(--s-line);
		outline-offset: 2px;
	}

	/* Glyph buttons — flat, no border, no bg */
	.voice-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		padding: 0;
		background: none;
		border: 0;
		border-radius: 0;
		color: var(--s-ink-3);
		cursor: pointer;
		transition: color 120ms ease;
		flex-shrink: 0;
	}

	.voice-btn:hover {
		color: var(--s-ink-2);
	}

	.voice-btn:focus-visible {
		outline: var(--s-hair) solid var(--s-line);
		outline-offset: 2px;
	}

	/* Mic recording — cinnabar glow (seal) */
	.voice-btn-active {
		color: var(--s-seal);
	}

	.voice-btn-active:hover {
		color: var(--s-seal);
	}

	/* Speaker "on" — moss (sage) to indicate live/connected */
	.voice-btn-on {
		color: var(--s-moss);
	}

	.voice-btn-on:hover {
		color: var(--s-moss);
	}

	/* Speaker actively playing — same moss, no shadow */
	.voice-btn-speaking {
		color: var(--s-moss);
	}

	/* Mic mid-send: dimmed */
	.voice-btn-processing {
		color: var(--s-ink-3);
		opacity: 0.4;
		cursor: not-allowed;
	}

	/* Voice unavailable */
	.voice-btn-disabled,
	.voice-btn:disabled {
		color: var(--s-ink-3);
		opacity: 0.35;
		cursor: not-allowed;
	}
	.voice-btn-disabled:hover {
		color: var(--s-ink-3);
	}

	/* Recording pulse ring — cinnabar */
	.voice-pulse {
		position: absolute;
		inset: -3px;
		border: 1px solid var(--s-seal);
		border-radius: 0;
		opacity: 0;
		animation: voice-pulse-anim 1.5s ease-out infinite;
		pointer-events: none;
	}

	/* Processing spinner inside the mic button */
	.voice-spinner {
		display: inline-block;
		width: 14px;
		height: 14px;
		border: 1px solid currentColor;
		border-right-color: transparent;
		border-radius: 50%;
		animation: voice-spinner-anim 0.7s linear infinite;
	}

	@keyframes voice-spinner-anim {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes voice-pulse-anim {
		0% {
			opacity: 0.5;
			transform: scale(1);
		}
		100% {
			opacity: 0;
			transform: scale(1.35);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.voice-pulse,
		.voice-spinner {
			animation: none;
		}
		.voice-pulse {
			opacity: 0.3;
		}
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border-width: 0;
	}
</style>
