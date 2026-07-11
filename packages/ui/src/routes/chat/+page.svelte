<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
	import ChatInput from '$lib/components/chat/ChatInput.svelte';
	import VoiceStatusStrip from '$lib/components/chat/VoiceStatusStrip.svelte';
	import SessionList from '$lib/components/chat/SessionList.svelte';
	import ToolLog from '$lib/components/chat/ToolLog.svelte';
	import Presence from '$lib/components/chat/Presence.svelte';
	import PermissionCard from '$lib/components/chat/PermissionCard.svelte';
	import QuestionCard from '$lib/components/chat/QuestionCard.svelte';
	import { createFocusTrap, handleTrapKeydown } from '@openpalm/ui-kit/actions/focus-trap.js';
	import { isLocalAssistantUrl } from '$lib/assistant-endpoint.js';
	// Direct domain-client import (plan Phase 3 step 4, #555): the chat page
	// must not import the $lib/api.js barrel, which re-exports every admin
	// domain client and would drag them all into the chat chunk.
	import { probeChatBackend } from '$lib/api/chat.js';
	import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
	import { buildAdvancedPath } from '$lib/chat/navigation.js';
	import { nextFollowState } from '$lib/chat/autoscroll.js';
	import { chat } from '$lib/chat/chat-state.svelte.js';
	import { renderMarkdown } from '$lib/markdown.js';
	import { endpointsService } from '$lib/endpoints-state.svelte.js';
	import { themeService } from '$lib/theme-state.svelte.js';
	import {
		voiceState,
		setTtsAutoEnabled,
		startListening,
		stopListening,
		startConversation,
		stopConversation,
		initVoice
	} from '$lib/voice/voice-state.svelte.js';
	import IconSoundOn from '@openpalm/ui-kit/components/icons/IconSoundOn.svelte';
	import IconSoundOff from '@openpalm/ui-kit/components/icons/IconSoundOff.svelte';
	import IconConversations from '@openpalm/ui-kit/components/icons/IconConversations.svelte';
	import IconActivity from '@openpalm/ui-kit/components/icons/IconActivity.svelte';
	import IconClose from '@openpalm/ui-kit/components/icons/IconClose.svelte';
	import IconThemeSystem from '@openpalm/ui-kit/components/icons/IconThemeSystem.svelte';
	import IconThemeLight from '@openpalm/ui-kit/components/icons/IconThemeLight.svelte';
	import IconThemeDark from '@openpalm/ui-kit/components/icons/IconThemeDark.svelte';
	import IconAdvanced from '@openpalm/ui-kit/components/icons/IconAdvanced.svelte';

	let scrollAnchorEl = $state<HTMLDivElement | undefined>();

	const entriesLoading = $derived(chat.entriesLoading);
	const sessionsLoading = $derived(
		chat.byEndpoint.get(chat.activeEndpointId)?.sessionsLoading ?? false
	);

	// ── Garden (session veil) ──────────────────────────────────────────
	let gardenOpen = $state(false);

	function openGarden(): void {
		gardenOpen = true;
	}
	function closeGarden(): void {
		gardenOpen = false;
	}

	// ── Tool activity sidebar (small screens) ──────────────────────────
	// On wide screens the activity list is a persistent left rail. Below the
	// breakpoint it collapses into this togglable drawer.
	let toolDrawerOpen = $state(false);

	function toggleToolDrawer(): void {
		toolDrawerOpen = !toolDrawerOpen;
	}
	function closeToolDrawer(): void {
		toolDrawerOpen = false;
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	async function reconnect(): Promise<void> {
		chat.error = '';
		// onEndpointChanged always calls loadSessions() internally — no separate call needed.
		await chat.onEndpointChanged(endpointsService.activeId);
	}

	async function retryFailedSend(): Promise<void> {
		const text = chat.lastFailedText;
		if (!text) return;
		chat.error = '';
		await chat.send(text);
	}

	async function handleSend(text: string): Promise<void> {
		await chat.send(text);
	}

	let permissionActionInFlight = $state<'once' | 'always' | 'reject' | null>(null);

	async function handlePermissionReply(reply: 'once' | 'always' | 'reject'): Promise<void> {
		permissionActionInFlight = reply;
		try {
			await chat.answerPermission(reply);
		} finally {
			permissionActionInFlight = null;
		}
	}

	async function handleQuestionOption(answer: string): Promise<void> {
		await chat.answerQuestion(answer);
	}

	function handleQuestionDraft(index: number, value: string): void {
		chat.setQuestionAnswer(index, value);
	}

	async function handleQuestionSubmit(): Promise<void> {
		await chat.answerQuestion();
	}

	async function handleQuestionReject(): Promise<void> {
		await chat.rejectQuestion();
	}

	// Whether the viewport is following the newest content. Mirrored out of the
	// autoscroll action so the "↓ latest" pill can render (and force-resume).
	let followingLatest = $state(true);

	function onFollowChange(following: boolean): void {
		followingLatest = following;
	}

	function scrollToLatest(): void {
		const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		scrollAnchorEl?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
	}

	function jumpToLatest(): void {
		followingLatest = true;
		scrollToLatest();
	}

	interface AutoscrollParams {
		isFollowing: () => boolean;
		onFollowChange: (following: boolean) => void;
	}

	// MutationObserver-based autoscroll: fires whenever the thread DOM changes
	// (new message, streaming text, loading spinners, permission cards, etc.)
	// — no $effect or afterUpdate needed. Auto-follow is conditional: a scroll
	// listener on the .s-scroll ancestor detaches on an upward scroll and
	// re-attaches near the bottom (see nextFollowState), so the user can read
	// earlier messages while a reply streams. Follow-state lives in page $state,
	// read through params.isFollowing so the pill can force-resume.
	function autoscroll(node: HTMLElement, params: AutoscrollParams): { destroy(): void } {
		const scroller = node.closest('.s-scroll') as HTMLElement | null;
		let prevScrollTop = scroller?.scrollTop ?? 0;
		function handleScroll(): void {
			if (!scroller) return;
			const following = params.isFollowing();
			const next = nextFollowState(
				following,
				prevScrollTop,
				scroller.scrollTop,
				scroller.clientHeight,
				scroller.scrollHeight
			);
			prevScrollTop = scroller.scrollTop;
			if (next !== following) params.onFollowChange(next);
		}
		scroller?.addEventListener('scroll', handleScroll, { passive: true });
		const observer = new MutationObserver(() => {
			if (!params.isFollowing()) return;
			const reduceMotion =
				typeof window !== 'undefined' &&
				window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			queueMicrotask(() =>
				scrollAnchorEl?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' })
			);
		});
		observer.observe(node, { childList: true, subtree: true, characterData: true });
		return {
			destroy() {
				observer.disconnect();
				scroller?.removeEventListener('scroll', handleScroll);
			}
		};
	}

	// ── Modal focus management ─────────────────────────────────────────────
	// The drawer and Conversations veil are persistent in the DOM and toggle via
	// an `open` boolean, so the trap runs only while open and restores focus on
	// the next frame (the opener's corner cell un-hides on close). Tab-wrap and
	// Escape are handled by the shared focus-trap primitives.

	// ── Voice / TTS ───────────────────────────────────────────────────────

	// Mic pulse tracks single-shot dictation only — conversation mode has
	// its own toggle + strip and would otherwise light both buttons.
	const voiceActive = $derived(
		!voiceState.conversationActive &&
			(voiceState.status === 'recording' || voiceState.status === 'transcribing')
	);
	const ttsEnabled = $derived(voiceState.ttsAutoEnabled);
	const voiceEnabled = $derived(voiceState.sttEngine !== 'disabled' && voiceState.sttSupported);
	const ttsAvailable = $derived(voiceState.ttsSupported);

	// Composer draft — dictation inserts here instead of auto-sending, so
	// the user reviews spoken text before it goes out. (The navbar
	// VoiceControl keeps its auto-send behavior on other pages.)
	let draft = $state('');

	function toggleVoice(): void {
		// Single-shot dictation and conversation mode are mutually exclusive.
		if (voiceState.conversationActive) {
			stopConversation();
			return;
		}
		if (voiceActive) {
			stopListening();
		} else {
			startListening((transcript) => {
				const trimmed = transcript.trim();
				if (!trimmed) return;
				draft = draft.trim().length > 0 ? `${draft.trimEnd()} ${trimmed}` : trimmed;
			});
		}
	}

	function toggleConversation(): void {
		if (voiceState.conversationActive) {
			stopConversation();
		} else {
			startConversation((text) => {
				// Barge-in aware: stops an in-flight reply before sending so the
				// utterance is never dropped by send()'s sending-guard.
				void chat.sendUtterance(text);
			});
		}
	}

	function toggleSpeak(): void {
		setTtsAutoEnabled(!voiceState.ttsAutoEnabled);
	}

	// ── New session ────────────────────────────────────────────────────────

	async function beginNew(): Promise<void> {
		await chat.startNewSession();
		await goto(resolve('/chat'), { replaceState: true });
		closeGarden();
	}

	// ── Endpoint switching ──────────────────────────────────────────────────

	let endpointSwitching = $state(false);

	async function activateEndpoint(id: string): Promise<void> {
		if (endpointSwitching) return;
		if (id === endpointsService.active?.id) {
			closeGarden();
			return;
		}
		endpointSwitching = true;
		try {
			await endpointsService.activate(id);
			closeGarden();
		} catch {
			/* error surfaced via endpointsService.error */
		} finally {
			endpointSwitching = false;
		}
	}

	// ── Mount ─────────────────────────────────────────────────────────────
	onMount(() => {
		document.documentElement.classList.add('chat-locked');
		document.body.classList.add('chat-locked', 'stillness-mode');

		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') {
				stopConversation();
				closeGarden();
				closeToolDrawer();
			}
		}
		document.addEventListener('keydown', onKey);

		let visDestroyed = false;
		function handleVisibilityChange(): void {
			if (visDestroyed || document.visibilityState !== 'visible') return;
			void (async () => {
				const reachable = await probeChatBackend();
				if (!reachable && !visDestroyed) {
					chat.error = 'Assistant is not reachable. Try reconnecting.';
				} else if (!visDestroyed) {
					await chat.loadSessions();
				}
			})();
		}
		document.addEventListener('visibilitychange', handleVisibilityChange);

		void initVoice();

		void (async () => {
			try {
				advancedModeService.init();
				const requestedSessionId = page.url.searchParams.get('session');
				if (advancedModeService.enabled) {
					// eslint-disable-next-line svelte/no-navigation-without-resolve -- dynamic session path built internally, not a static route id
					await goto(buildAdvancedPath(requestedSessionId), { replaceState: true });
					return;
				}
				await endpointsService.load();
				await chat.onEndpointChanged(endpointsService.activeId);
				if (requestedSessionId) {
					await chat.openSession(requestedSessionId);
				}
				if (page.url.searchParams.get('new') === '1') {
					await chat.startNewSession();
					await goto(resolve('/chat'), { replaceState: true });
				}
			} catch {
				chat.error = 'Unable to reach the assistant.';
			}
		})();

		return () => {
			visDestroyed = true;
			// Leaving the page ends the hands-free loop — the mic must not
			// stay hot on other routes.
			stopConversation();
			document.documentElement.classList.remove('chat-locked');
			document.body.classList.remove('chat-locked', 'stillness-mode');
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	});
</script>

<svelte:head>
	<title>{endpointsService.active?.label ?? 'OpenPalm'}</title>
</svelte:head>

<h1 class="sr-only">Chat</h1>

<!-- atmosphere -->
<div class="s-field"></div>
<div class="s-moon"></div>
<div class="s-grain"></div>

<!-- corners: the only persistent chrome -->
<!-- top-left: presence / logo -->
<div class="s-corner s-corner-left">
	<Presence
		height={32}
		{voiceEnabled}
		sending={chat.sending}
		voiceStatus={voiceState.status}
		onToggle={toggleVoice}
	/>
</div>

<!-- top-right: advanced -->
<div class="s-corner s-corner-right" class:drawer-hidden={toolDrawerOpen}>
	<div class="s-glyph-cell">
		<button
			class="s-glyph-btn"
			type="button"
			aria-label="Advanced mode"
			aria-pressed={advancedModeService.enabled}
			onclick={() => {
				advancedModeService.setEnabled(true);
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- dynamic session path built internally, not a static route id
				void goto(buildAdvancedPath(page.url.searchParams.get('session') ?? chat.activeSessionId));
			}}
		>
			<IconAdvanced size={20} />
		</button>
		<span class="s-glyph-label">advanced</span>
	</div>
</div>

<!-- bottom-left: voice (conditional) + theme toggle -->
<div class="s-corner s-corner-bottom-left">
	{#if ttsAvailable && voiceEnabled}
		<div class="s-glyph-cell">
			<span class="s-glyph-label">voice</span>
			<button
				class="s-glyph-btn"
				type="button"
				aria-label={ttsEnabled ? 'Turn off spoken responses' : 'Turn on spoken responses'}
				aria-pressed={ttsEnabled}
				onclick={toggleSpeak}
			>
				{#if ttsEnabled}
					<IconSoundOn size={20} />
				{:else}
					<IconSoundOff size={20} />
				{/if}
			</button>
		</div>
	{/if}
	<div class="s-glyph-cell">
		<span class="s-glyph-label">theme</span>
		<button
			class="s-glyph-btn s-orb-btn"
			type="button"
			onclick={() => themeService.toggle()}
			aria-label={themeService.preference === 'system'
				? 'Switch to light theme'
				: themeService.preference === 'light'
					? 'Switch to dark theme'
					: 'Switch to system theme'}
		>
			{#if themeService.preference === 'light'}
				<IconThemeLight size={20} />
			{:else if themeService.preference === 'dark'}
				<IconThemeDark size={20} />
			{:else}
				<IconThemeSystem size={20} />
			{/if}
		</button>
	</div>
</div>

<!-- bottom-right: activity (small screens) + conversations -->
<!-- Hidden while the drawer is open: the drawer owns the top layer (its close X,
     the scrim and Escape close it), so this cluster must not bleed through. -->
<div class="s-corner s-corner-bottom-right" class:drawer-hidden={toolDrawerOpen}>
	<div class="s-glyph-cell s-tool-toggle-cell">
		<span class="s-glyph-label">activity</span>
		<button
			class="s-glyph-btn"
			type="button"
			aria-haspopup="dialog"
			aria-expanded={toolDrawerOpen}
			aria-controls="s-tool-drawer"
			aria-label="Activity"
			onclick={toggleToolDrawer}
		>
			<IconActivity size={20} />
		</button>
	</div>
	<div class="s-glyph-cell">
		<span class="s-glyph-label">{gardenOpen ? 'close' : 'conversations'}</span>
		<button
			class="s-glyph-btn"
			type="button"
			aria-haspopup="dialog"
			aria-expanded={gardenOpen}
			aria-controls="s-garden-veil"
			onclick={gardenOpen ? closeGarden : openGarden}
			aria-label={gardenOpen ? 'Return to the conversation' : 'Conversations'}
		>
			{#if gardenOpen}
				<IconClose size={20} />
			{:else}
				<IconConversations size={22} />
			{/if}
		</button>
	</div>
</div>

<!-- left rail: running tool activity (wide screens) -->
<aside class="s-tool-rail" class:has-items={chat.toolLog.length > 0} aria-label="Assistant activity">
	<ToolLog items={chat.toolLog} />
</aside>

<!-- conversation thread -->
<main
	class="s-scroll"
	id="s-scroll"
	aria-label="Chat history"
	inert={toolDrawerOpen || gardenOpen}
>
	<div
		class="s-thread"
		id="s-thread"
		use:autoscroll={{ isFollowing: () => followingLatest, onFollowChange }}
	>
		{#if sessionsLoading || entriesLoading}
			<div class="s-loading" aria-live="polite">
				<span class="s-loading-text">loading…</span>
			</div>
		{/if}

		{#each chat.entries as entry (entry.id)}
			<ChatMessage {entry} />
		{/each}

		{#if chat.sending}
			<div class="s-pending" aria-live="polite">
				{#if chat.pendingAssistantText}
					<div class="turn master">
						<div class="master-words settled s-streaming">
							<!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown uses markdown-it with html:false, so raw HTML in assistant output is escaped (not rendered); only generated formatting markup reaches here -->
							<div class="markdown-body">{@html renderMarkdown(chat.pendingAssistantText)}</div>
						</div>
					</div>
				{:else if !chat.pendingPermission && !chat.pendingQuestion}
					<div class="s-thinking">
						<span class="s-thinking-text">thinking…</span>
					</div>
				{/if}

				{#if chat.pendingPermission}
					<PermissionCard
						permission={chat.pendingPermission}
						actionInFlight={permissionActionInFlight}
						onReply={handlePermissionReply}
					/>
				{/if}

				{#if chat.pendingQuestion}
					<QuestionCard
						question={chat.pendingQuestion}
						onOption={handleQuestionOption}
						onSelect={(index, label) => chat.setQuestionAnswer(index, label)}
						onDraft={handleQuestionDraft}
						onSubmit={handleQuestionSubmit}
						onReject={handleQuestionReject}
					/>
				{/if}
			</div>
		{/if}

		<div bind:this={scrollAnchorEl} aria-hidden="true" style="height:1px"></div>
	</div>
</main>

<!-- error banner -->
{#if chat.error}
	<div class="s-error-banner" role="alert">
		<span class="s-error-msg">{chat.error}</span>
		{#if chat.lastFailedText}
			<button class="s-error-reconnect" type="button" onclick={retryFailedSend}>retry</button>
		{/if}
		<button class="s-error-reconnect" type="button" onclick={reconnect}>reconnect</button>
		<button
			class="s-error-dismiss"
			type="button"
			aria-label="Dismiss"
			onclick={() => {
				chat.error = '';
			}}>×</button
		>
	</div>
{/if}

<!-- jump-to-latest pill: shown when the user has scrolled away mid-stream.
     Inert while the drawer or veil owns the top layer, like <main> and .s-base —
     the fixed pill must not stay clickable/focusable underneath them. -->
{#if !followingLatest && chat.sending}
	<button
		class="s-jump-latest"
		type="button"
		aria-label="Jump to latest"
		inert={toolDrawerOpen || gardenOpen}
		onclick={jumpToLatest}
	>
		↓ latest
	</button>
{/if}

<!-- composer -->
<div class="s-base" inert={toolDrawerOpen || gardenOpen}>
	<VoiceStatusStrip thinking={chat.sending} />
	<ChatInput
		bind:draft
		sending={chat.sending}
		questionPending={!!chat.pendingQuestion && chat.pendingQuestion.questions.length === 1}
		onSend={handleSend}
		onStop={() => void chat.stopTurn()}
		{voiceEnabled}
		{voiceActive}
		onMicToggle={toggleVoice}
		conversationEnabled={voiceEnabled}
		conversationActive={voiceState.conversationActive}
		onConversationToggle={toggleConversation}
	/>
</div>

<!-- garden veil -->
<div
	id="s-garden-veil"
	class="s-veil"
	class:open={gardenOpen}
	inert={!gardenOpen}
	aria-hidden={!gardenOpen}
	role="dialog"
	aria-modal="true"
	aria-label="Conversations and assistant"
	onkeydown={(event) => handleTrapKeydown(event, closeGarden)}
	{@attach createFocusTrap({ active: gardenOpen, deferRestore: true })}
>
	<div class="s-veil-head">
		<div>
			<div class="s-veil-title">Conversations</div>
			{#if endpointsService.active}
				<div class="s-veil-sub">{endpointsService.active.label}</div>
			{/if}
		</div>
		<button
			class="s-head-close"
			type="button"
			onclick={closeGarden}
			aria-label="Close conversations"
		>
			<IconClose size={20} />
		</button>
	</div>

	<div class="s-veil-body">
		<section class="s-veil-section">
			<div class="s-section-head">
				<div class="s-veil-section-label">assistant</div>
				<a class="s-new-convo" href={resolve('/connections')} onclick={closeGarden}>
					<span class="s-new-mark" aria-hidden="true">
						<svg width="11" height="11" viewBox="0 0 12 12" fill="none">
							<circle cx="6" cy="6" r="2.4" stroke="currentColor" stroke-width="1.1" />
							<line
								x1="4.5"
								y1="3.6"
								x2="4.5"
								y2="1.5"
								stroke="currentColor"
								stroke-width="1.1"
								stroke-linecap="round"
							/>
							<line
								x1="7.5"
								y1="3.6"
								x2="7.5"
								y2="1.5"
								stroke="currentColor"
								stroke-width="1.1"
								stroke-linecap="round"
							/>
							<line
								x1="6"
								y1="8.4"
								x2="6"
								y2="10.5"
								stroke="currentColor"
								stroke-width="1.1"
								stroke-linecap="round"
							/>
						</svg>
					</span>
					manage connections
				</a>
			</div>
			<div class="s-endpoint-list" role="group" aria-label="Assistant endpoints">
				{#each endpointsService.endpoints as ep (ep.id)}
					<div class="s-endpoint-item">
						<button
							type="button"
							class="s-endpoint"
							class:active={ep.id === endpointsService.active?.id}
							aria-current={ep.id === endpointsService.active?.id ? 'true' : undefined}
							onclick={() => void activateEndpoint(ep.id)}
							disabled={endpointSwitching}
						>
							<div class="s-endpoint-label">{ep.label}</div>
							<div class="s-endpoint-url">{ep.url}</div>
						</button>
						{#if ep.url && isLocalAssistantUrl(ep.url)}
							<a class="s-endpoint-manage" href={resolve('/host')} onclick={closeGarden}
								>manage this assistant</a
							>
						{/if}
					</div>
				{/each}
			</div>
		</section>

		<section class="s-veil-section">
			<div class="s-section-head">
				<div class="s-veil-section-label">conversations</div>
				<button class="s-new-convo" type="button" onclick={() => void beginNew()}>
					<span class="s-new-mark" aria-hidden="true">+</span> begin anew
				</button>
			</div>
			<SessionList onChosen={closeGarden} hideNewBtn={true} />
		</section>
	</div>
</div>

<!-- tool activity drawer (small screens) -->
{#if toolDrawerOpen}
	<button
		class="s-tool-scrim"
		type="button"
		tabindex={-1}
		aria-label="Close activity overlay"
		onclick={closeToolDrawer}
	></button>
{/if}
<div
	id="s-tool-drawer"
	class="s-tool-drawer"
	class:open={toolDrawerOpen}
	inert={!toolDrawerOpen}
	aria-hidden={!toolDrawerOpen}
	role="dialog"
	aria-modal="true"
	aria-label="Assistant activity"
	onkeydown={(event) => handleTrapKeydown(event, closeToolDrawer)}
	{@attach createFocusTrap({ active: toolDrawerOpen, deferRestore: true })}
>
	<div class="s-tool-drawer-head">
		<button
			class="s-head-close"
			type="button"
			onclick={closeToolDrawer}
			aria-label="Close activity"
		>
			<IconClose size={20} />
		</button>
	</div>
	<div class="s-tool-drawer-body">
		{#if chat.toolLog.length > 0}
			<ToolLog items={chat.toolLog} />
		{:else}
			<p class="s-tool-drawer-empty">
				Steps the assistant takes — searches, edits, commands — will show up here as it works.
			</p>
		{/if}
	</div>
</div>

<style>
	/* Hide the global navbar on the Stillness chat page */
	:global(body.stillness-mode .navbar) {
		display: none !important;
	}

	/* Visually hidden but available to assistive tech (document outline / h1). */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	/* ── Atmosphere ───────────────────────────────────────────────────── */

	.s-field {
		position: fixed;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		background: radial-gradient(120% 80% at 50% 14%, transparent 38%, var(--s-paper-deep) 100%);
		transition: background var(--s-t-theme) var(--s-ease);
	}

	.s-moon {
		position: fixed;
		z-index: 0;
		pointer-events: none;
		top: -7vmin;
		right: -7vmin;
		width: 46vmin;
		height: 46vmin;
		border-radius: 50%;
		opacity: 0;
		transition: opacity 1.4s var(--s-ease);
	}

	:global([data-theme='dark']) .s-moon,
	:global([data-theme='night']) .s-moon {
		opacity: 1;
		background: radial-gradient(
			circle at 38% 38%,
			rgba(218, 214, 201, 0.1),
			rgba(218, 214, 201, 0.02) 55%,
			transparent 70%
		);
	}

	.s-grain {
		position: fixed;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		opacity: var(--s-paper-grain);
		mix-blend-mode: soft-light;
		background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNjAnIGhlaWdodD0nMTYwJz48ZmlsdGVyIGlkPSduJz48ZmVUdXJidWxlbmNlIHR5cGU9J2ZyYWN0YWxOb2lzZScgYmFzZUZyZXF1ZW5jeT0nMC45JyBudW1PY3RhdmVzPScyJyBzdGl0Y2hUaWxlcz0nc3RpdGNoJy8+PC9maWx0ZXI+PHJlY3Qgd2lkdGg9JzEwMCUnIGhlaWdodD0nMTAwJScgZmlsdGVyPSd1cmwoI24pJy8+PC9zdmc+');
	}

	/* ── Corners ──────────────────────────────────────────────────────── */

	.s-corner {
		position: fixed;
		z-index: 70;
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		padding: var(--s-chrome-pad);
	}

	.s-corner-left {
		top: 0;
		left: 0;
		align-items: flex-start;
	}
	.s-corner-right {
		top: 0;
		right: 0;
		align-items: flex-start;
	}
	.s-corner-bottom-left {
		bottom: 0;
		left: 0;
	}
	.s-corner-bottom-right {
		bottom: 0;
		right: 0;
	}

	/* Each icon + its label stacked vertically */
	.s-glyph-cell {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
	}
	.s-corner-bottom-right .s-glyph-cell {
		align-items: flex-end;
	}
	.s-glyph-btn {
		appearance: none;
		border: 0;
		background: none;
		cursor: pointer;
		color: var(--s-ink-2);
		/* >= 44x44 hit area without enlarging the 20px icon and without the old
		   negative margin that pushed the focus ring off the viewport edge. The
		   surrounding --s-chrome-pad provides safe edge clearance. */
		min-width: 44px;
		min-height: 44px;
		padding: 0.4rem;
		margin: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		transition:
			color var(--s-t-quick) var(--s-ease),
			transform 0.6s var(--s-ease);
	}

	.s-glyph-btn:hover {
		color: var(--s-ink);
	}
	.s-glyph-btn:active {
		transform: scale(0.94);
	}
	.s-glyph-btn :global(.s-icon) {
		display: block;
	}

	.s-glyph-btn:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 1px var(--s-paper),
			0 0 0 2px var(--s-ink-3);
		border-radius: var(--s-radius-focus);
	}

	.s-glyph-label {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		opacity: 0;
		transform: translateY(2px);
		transition:
			opacity var(--s-t-quick) var(--s-ease),
			transform var(--s-t-quick) var(--s-ease);
		white-space: nowrap;
		pointer-events: none;
	}

	.s-glyph-cell:hover .s-glyph-label {
		opacity: 1;
		transform: none;
	}

	/* Touch devices have no hover — keep glyph labels persistently visible so the
	   cryptic icons (e.g. the ">_" advanced glyph) are never unlabelled. */
	@media (hover: none) {
		.s-glyph-label {
			opacity: 1;
			transform: none;
		}
	}

	.s-glyph-btn[aria-pressed='true'] {
		color: var(--s-seal);
	}

	/* While the activity drawer owns the top layer, hide the corner clusters that
	   would otherwise bleed over it (corners sit above the drawer otherwise). */
	.s-corner.drawer-hidden {
		display: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.s-glyph-btn {
			transition: color var(--s-t-quick) var(--s-ease);
		}
		.s-glyph-btn:active {
			transform: none;
		}
	}

	/* ── Conversation ─────────────────────────────────────────────────── */

	.s-scroll {
		position: relative;
		z-index: 10;
		height: 100dvh;
		overflow-y: auto;
		overflow-x: hidden;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
		background: var(--s-paper);
		transition: background var(--s-t-theme) var(--s-ease);
		-webkit-mask-image: linear-gradient(
			to bottom,
			transparent 0,
			var(--s-paper) 17%,
			var(--s-paper) 84%,
			transparent 100%
		);
		mask-image: linear-gradient(
			to bottom,
			transparent 0,
			var(--s-paper) 17%,
			var(--s-paper) 84%,
			transparent 100%
		);
	}

	.s-scroll::-webkit-scrollbar {
		display: none;
	}

	.s-thread {
		max-width: var(--s-measure);
		margin: 0 auto;
		padding: 34vh var(--s-frame) 40vh;
		display: flex;
		flex-direction: column;
		gap: var(--s-breath);
	}

	/* two-voice turn styles used from ChatMessage and inline for pending */
	:global(.turn) {
		display: flex;
		flex-direction: column;
	}

	:global(.turn.you) {
		align-items: flex-end;
		text-align: right;
	}

	:global(.you-words) {
		font-family: var(--s-font-header);
		font-weight: 300;
		font-size: var(--s-type-whisper);
		line-height: 1.5;
		color: var(--s-ink-2);
		max-width: 80%;
		text-wrap: pretty;
		border-width: 0 0 var(--s-hair);
		border-style: solid;
		border-color: color-mix(in srgb, var(--s-ink) 10%, transparent);
		border-radius: 0 0 10px 0;
		padding: 0 var(--s-sp-4) var(--s-sp-2);
	}

	:global(.turn.master) {
		gap: 0.9rem;
	}

	:global(.master-words) {
		font-family: var(--s-font-header);
		font-weight: 300;
		font-size: 1.6rem;
		line-height: 1.42;
		letter-spacing: 0.002em;
		color: var(--s-ink);
		text-wrap: pretty;
		max-width: 80%;
		border-width: var(--s-hair) 0 3px;
		border-style: solid;
		border-color: color-mix(in srgb, var(--s-ink) 9%, transparent);
		border-radius: 20px;
		padding: var(--s-sp-3) var(--s-sp-4) var(--s-sp-4);
	}

	:global(.master-words p) {
		margin: 0 0 0.6rem 0;
	}

	:global(.master-words p:last-child) {
		margin-bottom: 0;
	}

	.s-loading {
		display: flex;
		justify-content: center;
		padding: var(--s-breath) 0;
	}

	.s-loading-text {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
	}

	/* ── Pending / streaming ──────────────────────────────────────────── */

	.s-pending {
		display: flex;
		flex-direction: column;
		gap: var(--s-breath);
	}

	.s-streaming {
		/* Streamed text arrives as rendered markdown — block markup carries its
		   own line structure, so pre-wrap would double every source newline in
		   the generated HTML. */
		color: var(--s-ink) !important;
	}

	.s-thinking {
		display: flex;
		align-items: center;
	}

	.s-thinking-text {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
	}

	/* ── Presence + composer ──────────────────────────────────────────── */

	.s-base {
		position: fixed;
		z-index: 30;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0 var(--s-frame) clamp(1.4rem, 4vh, 2.4rem);
		background: linear-gradient(
			to top,
			var(--s-paper) 0%,
			var(--s-paper) 46%,
			color-mix(in srgb, var(--s-paper) 72%, transparent) 74%,
			transparent 100%
		);
		transition: background var(--s-t-theme) var(--s-ease);
		pointer-events: none;
	}

	.s-base > :global(*) {
		pointer-events: auto;
	}

	.s-base::before {
		content: '';
		position: absolute;
		left: 50%;
		bottom: 0;
		z-index: -1;
		width: min(34rem, 90%);
		height: 230px;
		transform: translateX(-50%);
		background: radial-gradient(
			60% 70% at 50% 64%,
			var(--s-paper) 0%,
			var(--s-paper) 40%,
			transparent 78%
		);
		pointer-events: none;
		transition: background var(--s-t-theme) var(--s-ease);
	}

	/* ── Error banner ─────────────────────────────────────────────────── */

	.s-error-banner {
		position: fixed;
		z-index: 50;
		bottom: clamp(6rem, 22vh, 10rem);
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 1rem;
		border: var(--s-hair) solid var(--s-line);
		background: var(--s-paper);
		max-width: min(32rem, 90vw);
		width: max-content;
	}

	.s-error-msg {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-deed);
		color: var(--s-seal);
		flex: 1;
	}

	.s-error-reconnect,
	.s-error-dismiss {
		appearance: none;
		border: var(--s-hair) solid var(--s-line);
		background: none;
		cursor: pointer;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: lowercase;
		color: var(--s-ink-2);
		padding: 0.2rem 0.6rem;
		border-radius: var(--s-radius-seal);
		white-space: nowrap;
	}

	.s-error-reconnect:hover {
		color: var(--s-ink);
	}
	.s-error-dismiss {
		border: 0;
		padding: 0.2rem 0.4rem;
	}
	.s-error-dismiss:hover {
		color: var(--s-seal);
	}

	/* ── Jump-to-latest pill ──────────────────────────────────────────── */

	.s-jump-latest {
		position: fixed;
		z-index: 40;
		bottom: clamp(6.5rem, 18vh, 9rem);
		left: 50%;
		transform: translateX(-50%);
		appearance: none;
		border: var(--s-hair) solid var(--s-line);
		background: var(--s-paper);
		cursor: pointer;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: lowercase;
		color: var(--s-ink-2);
		padding: 0.35rem 0.9rem;
		border-radius: var(--s-radius-seal);
		white-space: nowrap;
	}

	.s-jump-latest:hover {
		color: var(--s-ink);
	}

	.s-jump-latest:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 1px var(--s-paper),
			0 0 0 2px var(--s-ink-3);
	}

	/* ── Garden veil ──────────────────────────────────────────────────── */

	.s-veil {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: var(--s-paper);
		opacity: 0;
		pointer-events: none;
		transition:
			opacity 0.8s var(--s-ease),
			background var(--s-t-theme) var(--s-ease);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.s-veil.open {
		opacity: 1;
		pointer-events: auto;
	}

	.s-veil-head {
		padding: 20px 28px 14px;
		display: flex;
		align-items: baseline;
		gap: 1rem;
		max-width: var(--s-measure);
		width: 100%;
		margin: 0 auto;
		flex-shrink: 0;
		border-bottom: 1px solid var(--s-line-soft);
	}

	.s-veil-title {
		font-family: var(--s-font-header);
		font-weight: 400;
		font-size: 1.55rem;
		letter-spacing: 0.01em;
		color: var(--s-ink);
	}

	.s-veil-sub {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		margin-top: 0.3rem;
	}

	.s-veil-body {
		flex: 1;
		overflow-y: auto;
		scrollbar-width: none;
		margin: 0 auto;
		padding: 0.5rem clamp(1.4rem, 5vw, 3rem) clamp(2rem, 6vw, 3rem);
		width: 100%;
		max-width: var(--s-measure);
		display: flex;
		flex-direction: column;
		gap: clamp(2rem, 5vh, 3.2rem);
		min-height: 0;
	}

	.s-veil-body::-webkit-scrollbar {
		display: none;
	}

	.s-veil-section {
		display: flex;
		flex-direction: column;
	}

	.s-veil-section-label {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: 0.26em;
		text-transform: uppercase;
		color: var(--s-ink-3);
		margin-bottom: 0.7rem;
	}

	.s-section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0;
	}

	.s-section-head .s-veil-section-label {
		margin-bottom: 0;
	}

	.s-new-convo {
		appearance: none;
		border: 0;
		background: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		padding: 0;
		text-decoration: none;
		transition: color var(--s-t-quick) var(--s-ease);
	}

	.s-new-convo:hover {
		color: var(--s-seal);
	}

	.s-new-mark {
		color: var(--s-seal);
		font-size: 0.9rem;
		line-height: 1;
	}

	/* Endpoint list (inline Stillness style) */
	.s-endpoint-list {
		display: flex;
		flex-direction: column;
	}

	.s-endpoint {
		appearance: none;
		border: 0;
		background: none;
		cursor: pointer;
		text-align: left;
		width: 100%;
		position: relative;
		padding: 0.85rem 0 0.85rem 1.1rem;
		color: var(--s-ink);
		transition: none;
	}

	.s-endpoint::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0.7rem;
		bottom: 0.7rem;
		width: 2px;
		background: var(--s-seal);
		opacity: 0;
		transform: scaleY(0.4);
		transform-origin: center;
		transition:
			opacity 0.6s var(--s-ease),
			transform 0.6s var(--s-ease-settle);
	}

	.s-endpoint.active::before {
		opacity: 0.8;
		transform: scaleY(1);
	}

	.s-endpoint-label {
		font-family: var(--s-font-display);
		font-weight: 400;
		font-size: var(--s-type-whisper);
		color: var(--s-ink-2);
		transition: color var(--s-t-quick) var(--s-ease);
	}

	.s-endpoint.active .s-endpoint-label,
	.s-endpoint:hover .s-endpoint-label {
		color: var(--s-ink);
	}

	.s-endpoint-url {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: 0.06em;
		color: var(--s-ink-3);
		margin-top: 0.25rem;
	}

	.s-endpoint-item {
		display: flex;
		flex-direction: column;
	}

	.s-endpoint-manage {
		display: block;
		padding: 0.1rem 0 0.6rem 1.1rem;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		text-decoration: none;
		transition: color var(--s-t-quick) var(--s-ease);
	}

	.s-endpoint-manage:hover {
		color: var(--s-seal);
	}

	/* ── Tool activity: left rail (wide) + drawer (small) ─────────────── */

	.s-tool-rail {
		position: fixed;
		z-index: 20;
		left: 0;
		top: clamp(76px, 11vh, 120px);
		bottom: clamp(96px, 13vh, 150px);
		width: clamp(220px, 23vw, 300px);
		box-sizing: border-box;
		padding-left: var(--s-chrome-pad);
		padding-right: var(--s-sp-4);
		overflow-y: auto;
		scrollbar-width: none;
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--s-t-theme) var(--s-ease);
		/* Fade long lists at top/bottom to signal scrollability (mirrors .s-scroll). */
		-webkit-mask-image: linear-gradient(
			to bottom,
			transparent 0,
			var(--s-paper) 8%,
			var(--s-paper) 92%,
			transparent 100%
		);
		mask-image: linear-gradient(
			to bottom,
			transparent 0,
			var(--s-paper) 8%,
			var(--s-paper) 92%,
			transparent 100%
		);
	}

	.s-tool-rail::-webkit-scrollbar {
		display: none;
	}

	.s-tool-rail.has-items {
		opacity: 1;
		pointer-events: auto;
		/* Faint separator so the rail reads as a distinct panel beside the thread. */
		border-right: var(--s-hair) solid var(--s-line-soft);
	}

	.s-tool-toggle-cell {
		display: none;
	}

	/* Drawer + scrim are small-screen only — re-enabled in the narrow media
	   query below so they can never coexist with the persistent left rail. */
	.s-tool-scrim {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: none;
		appearance: none;
		border: 0;
		padding: 0;
		margin: 0;
		background: color-mix(in srgb, var(--s-ink) 55%, transparent);
		cursor: pointer;
	}

	.s-tool-drawer {
		position: fixed;
		z-index: 85;
		top: 0;
		right: 0;
		bottom: 0;
		width: clamp(260px, 82vw, 360px);
		display: none;
		flex-direction: column;
		background: var(--s-paper);
		border-left: var(--s-hair) solid var(--s-line);
		transform: translateX(100%);
		transition:
			transform 0.4s var(--s-ease),
			background var(--s-t-theme) var(--s-ease);
	}

	.s-tool-drawer.open {
		transform: translateX(0);
	}

	.s-tool-drawer-head {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 1rem;
		padding: 18px 20px 14px;
		border-bottom: var(--s-hair) solid var(--s-line-soft);
		flex-shrink: 0;
	}

	/* Shared head close button (drawer + veil), styled like the glyph buttons. */
	.s-head-close {
		appearance: none;
		border: 0;
		background: none;
		cursor: pointer;
		color: var(--s-ink-2);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		min-height: 44px;
		padding: 0.4rem;
		border-radius: 50%;
		transition: color var(--s-t-quick) var(--s-ease);
	}

	.s-head-close:hover {
		color: var(--s-ink);
	}

	.s-head-close:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 1px var(--s-paper),
			0 0 0 2px var(--s-ink-3);
		border-radius: var(--s-radius-focus);
	}

	.s-veil-head {
		justify-content: space-between;
	}

	.s-tool-drawer-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		scrollbar-width: none;
		/* Generous bottom padding (plus safe-area inset) so the last rows never end
		   flush against the bottom edge / floating chrome. */
		padding: 1rem 16px calc(4rem + env(safe-area-inset-bottom));
		/* Fade long lists at top/bottom to signal scrollability (mirrors .s-scroll). */
		-webkit-mask-image: linear-gradient(
			to bottom,
			transparent 0,
			var(--s-paper) 6%,
			var(--s-paper) 90%,
			transparent 100%
		);
		mask-image: linear-gradient(
			to bottom,
			transparent 0,
			var(--s-paper) 6%,
			var(--s-paper) 90%,
			transparent 100%
		);
	}

	.s-tool-drawer-body::-webkit-scrollbar {
		display: none;
	}

	.s-tool-drawer-empty {
		margin: 0;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
	}

	/* Wide screens: reserve the rail's width so the centered thread lives in the
	   REMAINING space and can never paint underneath the fixed rail. The reserved
	   padding MUST match .s-tool-rail width exactly (same clamp). */
	@media (min-width: 901px) {
		.s-scroll {
			padding-left: clamp(220px, 23vw, 300px);
		}
	}

	@media (max-width: 900px) {
		.s-tool-rail {
			display: none;
		}
		.s-tool-toggle-cell {
			display: flex;
		}
		.s-tool-scrim {
			display: block;
		}
		.s-tool-drawer {
			display: flex;
		}
	}

	@media (max-width: 520px) {
		.s-thread {
			padding-top: 30vh;
			padding-bottom: 44vh;
		}
	}

	/* Very small screens: let the drawer span the full viewport width. */
	@media (max-width: 360px) {
		.s-tool-drawer {
			width: 100vw;
		}
	}
</style>
