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
	} from '$lib/voice/voice-state.svelte.js';
	import { chat } from '$lib/chat/chat-state.svelte.js';

	let mounted = $state(false);

	onMount(() => {
		initVoice();
		mounted = true;
	});

	onDestroy(() => {
		destroyVoice();
	});

	let supported = $derived(mounted && voiceState.isSupported);
	let ttsAvailable = $derived(mounted && voiceState.ttsSupported);

	/**
	 * Mic: always captures. The transcript is submitted straight to the
	 * global chat service, which posts to the currently selected OpenCode
	 * backend. Works from any page because `chat` is a singleton and the
	 * Navbar (containing this component) is mounted everywhere.
	 */
	function handleMicClick(): void {
		if (voiceState.status === 'listening') {
			stopListening();
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

{#if supported}
	<div class="voice-control" role="toolbar" aria-label="Voice controls">
		<button
			class="voice-btn"
			class:voice-btn-active={voiceState.status === 'listening'}
			onclick={handleMicClick}
			aria-label={voiceState.status === 'listening' ? 'Stop listening' : 'Start dictation'}
			aria-pressed={voiceState.status === 'listening'}
			title={voiceState.status === 'listening'
				? 'Stop listening'
				: 'Dictate into focused field'}
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
				<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
				<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
				<line x1="12" y1="19" x2="12" y2="23" />
				<line x1="8" y1="23" x2="16" y2="23" />
			</svg>
			{#if voiceState.status === 'listening'}
				<span class="voice-pulse" aria-hidden="true"></span>
			{/if}
		</button>

		{#if ttsAvailable}
			<button
				class="voice-btn"
				class:voice-btn-on={voiceState.ttsAutoEnabled}
				onclick={handleSpeakerClick}
				aria-label={voiceState.ttsAutoEnabled
					? 'Turn off spoken responses'
					: 'Turn on spoken responses'}
				aria-pressed={voiceState.ttsAutoEnabled}
				title={voiceState.ttsAutoEnabled
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
					<path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
					<path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
				</svg>
			</button>
		{/if}

		{#if voiceState.errorMessage}
			<span class="voice-error" role="alert">{voiceState.errorMessage}</span>
		{/if}

		<span class="sr-only" aria-live="polite">
			{voiceState.status === 'listening'
				? 'Listening for speech'
				: voiceState.status === 'speaking'
					? 'Reading aloud'
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
		gap: var(--space-1);
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

	.voice-pulse {
		position: absolute;
		inset: -3px;
		border: 2px solid var(--color-danger);
		border-radius: var(--radius-md);
		opacity: 0;
		animation: voice-pulse-anim 1.5s ease-out infinite;
		pointer-events: none;
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
		.voice-pulse {
			animation: none;
			opacity: 0.4;
		}
	}

	.voice-error {
		font-size: var(--text-xs);
		color: var(--color-danger);
		max-width: 160px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
