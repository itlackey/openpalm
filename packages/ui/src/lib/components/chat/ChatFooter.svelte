<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChatActivity from './ChatActivity.svelte';
	import NewChatButton from './NewChatButton.svelte';
	import VoiceControl from './VoiceControl.svelte';
	import VoiceStatusStrip from './VoiceStatusStrip.svelte';

	type Props = {
		notice?: Snippet;
		composer?: Snippet;
		thinking?: boolean;
		showConversationActions?: boolean;
		drawerOpen?: boolean;
		railOpen?: boolean;
		conversationTitle?: string;
		connectionLabel?: string;
		draft?: string;
		dictationMode?: 'draft' | 'send';
	};

	let {
		notice,
		composer,
		thinking = false,
		showConversationActions = false,
		drawerOpen = $bindable(false),
		railOpen = $bindable(true),
		conversationTitle = '',
		connectionLabel = '',
		draft = $bindable(''),
		dictationMode = 'send'
	}: Props = $props();
</script>

<footer class="chat-footer" class:has-composer={composer}>
	<div class="chat-footer-status" inert={drawerOpen}>
		<VoiceStatusStrip {thinking} />
	</div>
	{#if notice}
		<div class="chat-footer-notice" inert={drawerOpen}>
			{@render notice()}
		</div>
	{/if}
	{#if composer}
		<div class="chat-footer-composer" inert={drawerOpen}>
			{@render composer()}
		</div>
	{/if}
	<div class="chat-footer-actions">
		{#if showConversationActions}
			<div class="chat-footer-conversation-actions">
				<span inert={drawerOpen}><NewChatButton /></span>
				<ChatActivity
					bind:drawerOpen
					bind:railOpen
					{conversationTitle}
					{connectionLabel}
				/>
			</div>
		{/if}
		<div class="chat-footer-voice" inert={drawerOpen}>
			<VoiceControl bind:draft {dictationMode} />
		</div>
	</div>
</footer>

<style>
	.chat-footer {
		position: relative;
		z-index: 70;
		box-sizing: border-box;
		display: flex;
		width: 100%;
		min-height: 60px;
		flex-shrink: 0;
		flex-direction: column;
		padding: var(--s-sp-2) max(var(--s-sp-4), env(safe-area-inset-right))
			max(var(--s-sp-2), env(safe-area-inset-bottom))
			max(var(--s-sp-4), env(safe-area-inset-left));
		border-top: var(--s-hair) solid var(--s-line-soft);
		background: var(--s-paper);
	}

	.chat-footer.has-composer {
		padding-top: var(--s-sp-3);
	}

	.chat-footer-status {
		display: flex;
		align-self: stretch;
		justify-content: center;
	}

	.chat-footer-status :global(.voice-status-strip) {
		align-self: center;
		margin-bottom: var(--s-sp-1);
	}

	.chat-footer-notice {
		display: flex;
		width: 100%;
		flex-direction: column;
		align-items: center;
		padding-bottom: var(--s-sp-2);
	}
	.chat-footer-notice:empty {
		display: none;
		padding: 0;
	}

	.chat-footer-composer {
		display: flex;
		width: 100%;
		justify-content: center;
		padding-bottom: var(--s-sp-2);
	}

	.chat-footer-actions,
	.chat-footer-conversation-actions,
	.chat-footer-voice {
		display: flex;
		align-items: center;
		gap: var(--s-sp-1);
	}

	.chat-footer-actions {
		width: 100%;
		min-height: 44px;
		justify-content: flex-end;
	}

	.chat-footer-conversation-actions {
		margin-right: auto;
	}

	.chat-footer-conversation-actions > span {
		display: inline-flex;
	}

	@media (min-width: 1000px) {
		.chat-footer.has-composer {
			display: grid;
			grid-template-areas:
				'status status status'
				'notice notice notice'
				'conversation composer voice';
			grid-template-columns: minmax(0, 1fr) minmax(20rem, 34rem) minmax(0, 1fr);
			align-items: end;
			column-gap: var(--s-sp-3);
			padding-top: var(--s-sp-1);
			padding-bottom: max(var(--s-sp-1), env(safe-area-inset-bottom));
		}

		.has-composer .chat-footer-status {
			grid-area: status;
		}

		.has-composer .chat-footer-notice {
			grid-area: notice;
		}

		.has-composer .chat-footer-composer {
			grid-area: composer;
			min-width: 0;
			padding-bottom: 0;
		}

		.has-composer .chat-footer-actions {
			display: contents;
		}

		.has-composer .chat-footer-conversation-actions {
			grid-area: conversation;
			justify-self: start;
			margin-right: 0;
		}

		.has-composer .chat-footer-voice {
			grid-area: voice;
			justify-self: end;
		}
	}
</style>
