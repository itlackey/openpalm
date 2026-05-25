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
	import { chat } from '$lib/chat/chat-state.svelte.js';

	let mounted = $state(false);

	onMount(() => {
		void initVoice().then(() => {
			mounted = true;
		});
	});

	onDestroy(() => {
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
	function handleMicClick(): void {
		if (isRecording) {
			stopListening();
			return;
		}
		if (isTranscribing) {
			// Mid-transcription click is a no-op (the result is pending).
			return;
		}
		// If TTS is mid-utterance, stop it so we don't hear ourselves over
		// the assistant's previous response.
		stopSpeaking();

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

{#if supported || ttsAvailable || voiceState.autoplayBlocked}
	<div class="voice-control" role="toolbar" aria-label="Voice controls">
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
				<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
					<line x1="23" y1="9" x2="17" y2="15" />
					<line x1="17" y1="9" x2="23" y2="15" />
				</svg>
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
				<svg
					aria-hidden="true"
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
					{#if voiceState.ttsAutoEnabled}
						<!-- Sound waves: one when idle, both animated when speaking -->
						<path d="M15.54 8.46a5 5 0 0 1 0 7.07" class:wave-anim={isSpeaking} />
						<path d="M19.07 4.93a10 10 0 0 1 0 14.14" class:wave-anim-2={isSpeaking} />
					{:else}
						<!-- Muted: cross-out in place of the waves -->
						<line x1="23" y1="9" x2="17" y2="15" />
						<line x1="17" y1="9" x2="23" y2="15" />
					{/if}
				</svg>
			</button>
		{/if}

		{#if supported}
			<button
				class="voice-btn"
				class:voice-btn-active={isRecording}
				class:voice-btn-processing={isProcessing || isTranscribing}
				disabled={isProcessing}
				onclick={handleMicClick}
				aria-label={isRecording
					? 'Stop recording'
					: isTranscribing
						? 'Transcribing…'
						: isProcessing
							? 'Sending message…'
							: 'Start recording'}
				aria-pressed={isRecording}
				title={isRecording
					? 'Stop recording'
					: isTranscribing
						? 'Transcribing…'
						: isProcessing
							? 'Sending message…'
							: 'Speak — message will be sent to the selected assistant'}
			>
				{#if isTranscribing || isProcessing}
					<!-- Spinner while audio is being transcribed or the message is in flight -->
					<span class="voice-spinner" aria-hidden="true"></span>
				{:else if isRecording}
					<!-- Stop-square: clicking again ends the recording -->
					<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
						<rect x="6" y="6" width="12" height="12" rx="1.5" />
					</svg>
					<span class="voice-pulse" aria-hidden="true"></span>
				{:else}
					<!-- Idle mic -->
					<svg
						aria-hidden="true"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
						<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
						<line x1="12" y1="19" x2="12" y2="23" />
						<line x1="8" y1="23" x2="16" y2="23" />
					</svg>
				{/if}
			</button>
		{/if}

		<!-- Errors surface via the global <Toast> in the root layout. Keeping
		     them out of the navbar prevents a long message from causing the
		     navbar to overflow horizontally on narrow widths. -->

		<span class="sr-only" aria-live="polite">
			{isRecording
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
{/if}

<style>
	.voice-control {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	/* Scoped "click to resume" banner — replaces the old document-wide
	   click listener so unrelated clicks never trigger stale audio. */
	.voice-autoplay-banner {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: 4px var(--space-3);
		height: 32px;
		background: var(--color-primary-subtle);
		border: 1px solid var(--color-primary);
		border-radius: var(--radius-md);
		color: var(--color-primary);
		font-size: var(--text-xs);
		font-weight: var(--font-medium);
		cursor: pointer;
		white-space: nowrap;
		transition: filter var(--transition-fast);
	}
	.voice-autoplay-banner:hover {
		filter: brightness(1.05);
	}
	.voice-autoplay-banner:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.voice-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: all var(--transition-fast);
		flex-shrink: 0;
	}

	.voice-btn:hover {
		color: var(--color-text);
		border-color: var(--color-border-hover);
		background: var(--color-surface-hover);
	}

	.voice-btn:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: -2px;
	}

	.voice-btn-active {
		color: var(--color-danger);
		border-color: var(--color-danger);
		background: var(--color-danger-bg);
	}

	.voice-btn-active:hover {
		color: var(--color-danger);
		border-color: var(--color-danger);
	}

	/* Speaker toggle "on" state — distinct from the mic's recording-active state. */
	.voice-btn-on {
		color: var(--color-primary);
		border-color: var(--color-primary);
		background: var(--color-primary-subtle);
	}

	.voice-btn-on:hover {
		color: var(--color-primary);
		border-color: var(--color-primary);
	}

	/* Speaker actively playing audio — slightly brighter background. */
	.voice-btn-speaking {
		background: var(--color-primary-subtle);
		box-shadow: 0 0 0 2px var(--color-primary-subtle);
	}

	/* Mic mid-send: dimmed; disabled cursor is set by the [disabled] attribute. */
	.voice-btn-processing {
		color: var(--color-text-tertiary);
		cursor: not-allowed;
	}

	.voice-pulse {
		position: absolute;
		inset: -3px;
		border: 2px solid var(--color-danger);
		border-radius: var(--radius-md);
		opacity: 0;
		animation: voice-pulse-anim 1.5s ease-out infinite;
		pointer-events: none;
	}

	/* Processing spinner inside the mic button. */
	.voice-spinner {
		display: inline-block;
		width: 14px;
		height: 14px;
		border: 2px solid currentColor;
		border-right-color: transparent;
		border-radius: 50%;
		animation: voice-spinner-anim 0.7s linear infinite;
	}

	@keyframes voice-spinner-anim {
		to {
			transform: rotate(360deg);
		}
	}

	/* Speaker wave animation while speaking. */
	.wave-anim {
		animation: wave-pulse-anim 1.2s ease-in-out infinite;
		transform-origin: 11px 12px;
	}

	.wave-anim-2 {
		animation: wave-pulse-anim 1.2s ease-in-out infinite 0.3s;
		transform-origin: 11px 12px;
	}

	@keyframes wave-pulse-anim {
		0%, 100% {
			opacity: 0.4;
		}
		50% {
			opacity: 1;
		}
	}

	@keyframes voice-pulse-anim {
		0% {
			opacity: 0.6;
			transform: scale(1);
		}
		100% {
			opacity: 0;
			transform: scale(1.3);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.voice-pulse,
		.voice-spinner,
		.wave-anim,
		.wave-anim-2 {
			animation: none;
		}
		.voice-pulse {
			opacity: 0.4;
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
