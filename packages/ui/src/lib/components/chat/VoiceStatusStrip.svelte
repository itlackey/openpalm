<script lang="ts">
	import { voiceState, resumeAutoplay } from '$lib/voice/voice-state.svelte.js';
	import IconSoundOff from '@openpalm/ui-kit/components/icons/IconSoundOff.svelte';

	interface Props {
		/** True while the assistant is composing a reply (chat.sending). */
		thinking?: boolean;
	}

	let { thinking = false }: Props = $props();

	// Chat page has no navbar (stillness mode hides it), so VoiceControl's
	// interim-transcript chip and autoplay-resume banner never render there.
	// This strip surfaces the same two states directly above the composer.
	let showInterim = $derived(
		voiceState.status === 'recording' && voiceState.interimTranscript.length > 0
	);
	let showTranscribing = $derived(voiceState.status === 'transcribing');
	let showAutoplayBlocked = $derived(voiceState.autoplayBlocked);
	let conversation = $derived(voiceState.conversationActive);
	// Priority: speaking > thinking > listening. `status` is the voice
	// pipeline's own state; `thinking` covers the chat round-trip where the
	// mic is armed but the assistant hasn't started speaking yet.
	let conversationLabel = $derived(
		voiceState.status === 'speaking'
			? 'speaking…'
			: voiceState.status === 'transcribing' || thinking
				? 'thinking…'
				: 'listening…'
	);
	let visible = $derived(conversation || showInterim || showTranscribing || showAutoplayBlocked);
	// Autoplay recovery must never be shadowed by conversation mode: this
	// strip is the only resume surface on /chat, and a blocked first
	// utterance keeps the playback pipeline busy so every queued reply
	// stalls until the user clicks resume.
	let srMessage = $derived(
		[
			conversation
				? `Conversation: ${voiceState.interimTranscript || conversationLabel}`
				: showInterim
					? `Recording: ${voiceState.interimTranscript}`
					: showTranscribing
						? 'Transcribing'
						: '',
			showAutoplayBlocked ? 'Audio paused — click to resume' : ''
		]
			.filter(Boolean)
			.join('. ')
	);
</script>

<!-- Renders nothing when idle so the composer layout never shifts. -->
{#if visible}
	<div class="voice-status-strip">
		{#if conversation}
			<span class="voice-status-interim">{voiceState.interimTranscript || conversationLabel}</span>
		{:else if showInterim}
			<span class="voice-status-interim">{voiceState.interimTranscript}</span>
		{:else if showTranscribing}
			<span class="voice-status-transcribing">transcribing…</span>
		{/if}
		<!-- Deliberately outside the branch chain above: the resume button
		     must stay reachable while conversation mode is active. -->
		{#if showAutoplayBlocked}
			<button
				type="button"
				class="voice-status-autoplay"
				onclick={() => resumeAutoplay()}
				aria-label="Resume paused audio"
				title="Audio was blocked by the browser. Click to resume."
			>
				<IconSoundOff size={14} />
				<span>Audio paused — click to resume</span>
			</button>
		{/if}
	</div>
{/if}

<span class="sr-only" aria-live="polite">{srMessage}</span>

<style>
	.voice-status-strip {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: var(--s-sp-2);
		margin-bottom: var(--s-sp-2);
		max-width: 100%;
	}

	.voice-status-interim,
	.voice-status-transcribing {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
		padding: 2px var(--s-sp-2);
		border: var(--s-hair) solid var(--s-line-soft);
		border-radius: 2px;
	}

	.voice-status-autoplay {
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

	.voice-status-autoplay:hover {
		color: var(--s-ink-2);
		border-color: var(--s-line);
	}

	.voice-status-autoplay:focus-visible {
		outline: var(--s-hair) solid var(--s-line);
		outline-offset: 2px;
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
