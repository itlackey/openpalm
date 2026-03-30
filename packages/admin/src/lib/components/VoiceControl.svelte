<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		voiceState,
		initVoice,
		destroyVoice,
		startListening,
		stopListening,
		speakText,
		stopSpeaking,
	} from '$lib/voice/voice-state.svelte.js';

	let mounted = $state(false);

	/** Track the last focused input/textarea so dictation works after mic click steals focus. */
	let lastFocusedInput: HTMLInputElement | HTMLTextAreaElement | null = null;
	let abortController: AbortController | null = null;

	function handleFocusIn(e: FocusEvent): void {
		const target = e.target;
		if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
			lastFocusedInput = target;
		}
	}

	onMount(() => {
		abortController = new AbortController();
		document.addEventListener('focusin', handleFocusIn, { signal: abortController.signal });
		initVoice();
		mounted = true;
	});

	onDestroy(() => {
		abortController?.abort();
		destroyVoice();
	});

	let supported = $derived(mounted && voiceState.isSupported);
	let ttsAvailable = $derived(mounted && voiceState.ttsSupported);

	function isSecretElement(el: Element | null): boolean {
		if (!el) return true;
		if (el instanceof HTMLInputElement && el.type === 'password') return true;
		if (el.hasAttribute('data-secret')) return true;
		return false;
	}

	function handleMicClick(): void {
		if (voiceState.status === 'listening') {
			stopListening();
			return;
		}

		startListening((transcript: string) => {
			const target = lastFocusedInput;
			if (!target || isSecretElement(target)) return;
			if (!target.isConnected) return;
			const start = target.selectionStart ?? target.value.length;
			const end = target.selectionEnd ?? target.value.length;
			const before = target.value.slice(0, start);
			const after = target.value.slice(end);
			const separator = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
			target.value = before + separator + transcript + after;
			target.dispatchEvent(new Event('input', { bubbles: true }));
			const newPos = start + separator.length + transcript.length;
			target.setSelectionRange(newPos, newPos);
			target.focus();
		});
	}

	function handleReadAloud(): void {
		if (voiceState.status === 'speaking') {
			stopSpeaking();
			return;
		}

		const sel = window.getSelection();
		const anchorEl =
			sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
		if (!isSecretElement(anchorEl ?? null)) {
			const selection = sel?.toString().trim();
			if (selection) {
				speakText(selection);
				return;
			}
		}

		const target = lastFocusedInput;
		if (target && target.isConnected && !isSecretElement(target)) {
			const text = target.value.trim();
			if (text) {
				speakText(text);
			}
		}
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
				class:voice-btn-active={voiceState.status === 'speaking'}
				onclick={handleReadAloud}
				aria-label={voiceState.status === 'speaking' ? 'Stop reading' : 'Read aloud'}
				aria-pressed={voiceState.status === 'speaking'}
				title={voiceState.status === 'speaking'
					? 'Stop reading'
					: 'Read selected text aloud'}
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
