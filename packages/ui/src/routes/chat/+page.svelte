<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import { page } from '$app/state';
	import { goto, replaceState } from '$app/navigation';
	import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
	import ChatInput from '$lib/components/chat/ChatInput.svelte';
	import ChatActivity from '$lib/components/chat/ChatActivity.svelte';
	import NewChatButton from '$lib/components/chat/NewChatButton.svelte';
	import ChatNavbar from '$lib/components/chrome/ChatNavbar.svelte';
	import VoiceStatusStrip from '$lib/components/chat/VoiceStatusStrip.svelte';
	import ToolLog from '$lib/components/chat/ToolLog.svelte';
	import PermissionCard from '$lib/components/chat/PermissionCard.svelte';
	import QuestionCard from '$lib/components/chat/QuestionCard.svelte';
	// Direct domain-client import (#555): the chat page
	// must not import the $lib/api.js barrel, which re-exports every admin
	// domain client and would drag them all into the chat chunk.
	import { probeChatBackend } from '$lib/api/chat.js';
	import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
	import { buildAdvancedPath, buildChatPath } from '$lib/chat/navigation.js';
	import { nextFollowState } from '$lib/chat/autoscroll.js';
	import { chat } from '$lib/chat/chat-state.svelte.js';
	import { renderMarkdown } from '$lib/markdown.js';
	import { endpointsService } from '$lib/endpoints-state.svelte.js';
	import { onConnectionActivated } from '$lib/connection-events.js';
	import { resolveSessionTitle } from '$lib/session-title.js';
	import {
		voiceState,
		setTtsAutoEnabled,
		startConversation,
		startListening,
		stopListening,
		stopConversation,
		initVoice
	} from '$lib/voice/voice-state.svelte.js';
	import IconMic from '@openpalm/ui-kit/components/icons/IconMic.svelte';
	import IconSoundOff from '@openpalm/ui-kit/components/icons/IconSoundOff.svelte';
	import IconSoundOn from '@openpalm/ui-kit/components/icons/IconSoundOn.svelte';
	import IconStop from '@openpalm/ui-kit/components/icons/IconStop.svelte';
	import IconWaves from '@openpalm/ui-kit/components/icons/IconWaves.svelte';

	let scrollAnchorEl = $state<HTMLDivElement | undefined>();

	const entriesLoading = $derived(chat.entriesLoading);
	const sessionsLoading = $derived(
		chat.byEndpoint.get(chat.activeEndpointId)?.sessionsLoading ?? false
	);
	const activeSession = $derived(
		chat.byEndpoint
			.get(chat.activeEndpointId)
			?.sessions.find((session) => session.id === chat.activeSessionId) ?? null
	);
	const activeConversationTitle = $derived(
		activeSession ? resolveSessionTitle(activeSession.title) : 'New conversation'
	);
	const activeConnectionLabel = $derived(endpointsService.active?.label ?? 'No active connection');

	let navigationOpen = $state(false);
	let activityRailOpen = $state(true);
	let reducedMotion = $state(false);

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
		await tick();
		const endpointState = chat.byEndpoint.get(endpointsService.activeId);
		await syncSessionUrl(
			endpointState?.activeSessionId ?? endpointState?.sessions[0]?.id ?? null,
			true
		);
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

	// ── Voice ─────────────────────────────────────────────────────────────

	// Mic pulse tracks single-shot dictation only — conversation mode has
	// its own toggle + strip and would otherwise light both buttons.
	const voiceActive = $derived(
		!voiceState.conversationActive &&
			(voiceState.status === 'recording' || voiceState.status === 'transcribing')
	);
	const voiceEnabled = $derived(voiceState.sttEngine !== 'disabled' && voiceState.sttSupported);
	const ttsEnabled = $derived(voiceState.ttsEngine !== 'disabled' && voiceState.ttsSupported);
	const dictationTranscribing = $derived(
		!voiceState.conversationActive && voiceState.status === 'transcribing'
	);
	type OpenPalmVoiceBridge = {
		requestMicPermission?: () => Promise<string>;
	};

	// Composer draft — dictation inserts here instead of auto-sending, so
	// the user reviews spoken text before it goes out.
	let draft = $state('');

	async function prepareMicrophoneAccess(): Promise<boolean> {
		const openpalm = (window as Window & { openpalm?: OpenPalmVoiceBridge }).openpalm;
		const status = await openpalm?.requestMicPermission?.();
		if (status === 'denied-no-prompt') {
			voiceState.errorMessage =
				'This OpenPalm build cannot request microphone access on macOS. Please update to the latest version of the desktop app.';
			return false;
		}
		if (status === 'denied' || status === 'restricted') {
			voiceState.errorMessage =
				'Microphone access is turned off. In the System Settings window that just opened, enable OpenPalm under Microphone, then quit and reopen the app.';
			return false;
		}
		return true;
	}

	async function toggleVoice(): Promise<void> {
		// startListening takes the mic from conversation mode, so the dedicated
		// record control always does what its accessible name promises.
		if (voiceActive) {
			stopListening();
		} else if (await prepareMicrophoneAccess()) {
			startListening((transcript) => {
				const trimmed = transcript.trim();
				if (!trimmed) return;
				draft = draft.trim().length > 0 ? `${draft.trimEnd()} ${trimmed}` : trimmed;
			});
		}
	}

	async function toggleConversation(): Promise<void> {
		if (voiceState.conversationActive) {
			stopConversation();
			return;
		}
		if (!(await prepareMicrophoneAccess())) return;
		startConversation((transcript) => void handleSend(transcript));
	}

	function toggleSpokenResponses(): void {
		setTtsAutoEnabled(!voiceState.ttsAutoEnabled);
	}

	async function syncSessionUrl(sessionId: string | null, replace: boolean): Promise<void> {
		const target = buildChatPath(sessionId, endpointsService.activeId);
		if (`${page.url.pathname}${page.url.search}` === target) return;
		if (replace) {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- canonical session path built internally
			replaceState(target, page.state);
			return;
		}
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- canonical session path built internally
		await goto(target);
	}

	// ── Mount ─────────────────────────────────────────────────────────────
	onMount(() => {
		document.documentElement.classList.add('chat-locked');
		document.body.classList.add('chat-locked');
		const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
		const updateMotionPreference = (): void => {
			reducedMotion = motionPreference.matches;
		};
		updateMotionPreference();
		motionPreference.addEventListener('change', updateMotionPreference);

		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape' && voiceState.conversationActive) stopConversation();
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
		const unsubscribeSessionNavigation = onConnectionActivated(async (endpointId) => {
			await tick();
			const endpointState = chat.byEndpoint.get(endpointId);
			await syncSessionUrl(
				endpointState?.activeSessionId ?? endpointState?.sessions[0]?.id ?? null,
				true
			);
		});

		void initVoice();

		void (async () => {
			try {
				advancedModeService.init();
				const requestedSessionId = page.url.searchParams.get('session');
				const requestedAssistantId = page.url.searchParams.get('assistant');
				const beginNewRequested = page.url.searchParams.get('new') === '1';
				if (advancedModeService.enabled) {
					// eslint-disable-next-line svelte/no-navigation-without-resolve -- dynamic session path built internally, not a static route id
					await goto(buildAdvancedPath(requestedSessionId, requestedAssistantId), {
						replaceState: true
					});
					return;
				}
				await endpointsService.load();
				// Another shell component can already own the in-flight load. load()
				// returns early in that case, so wait for that shared request to settle.
				while (!endpointsService.loaded && !endpointsService.error) {
					await new Promise<void>((resolveLoad) => setTimeout(resolveLoad, 0));
				}
				let endpointId =
					endpointsService.activeId || endpointsService.endpoints[0]?.id || 'default';
				const requestedAssistantExists =
					requestedAssistantId !== null &&
					endpointsService.endpoints.some((endpoint) => endpoint.id === requestedAssistantId);
				if (requestedAssistantExists && requestedAssistantId !== endpointsService.activeId) {
					await endpointsService.activate(requestedAssistantId);
					endpointId = requestedAssistantId;
				} else {
					await chat.onEndpointChanged(endpointId);
				}
				const endpointState = chat.byEndpoint.get(endpointId);
				const requestedSessionExists =
					requestedSessionId !== null &&
					Boolean(endpointState?.sessions.some((session) => session.id === requestedSessionId));
				let canonicalSessionId: string | null = requestedSessionExists
					? requestedSessionId
					: (endpointState?.activeSessionId ?? endpointState?.sessions[0]?.id ?? null);
				if (requestedSessionExists && requestedSessionId !== chat.activeSessionId) {
					await chat.openSession(requestedSessionId);
				}
				if (beginNewRequested) {
					canonicalSessionId = await chat.startNewSession();
				}
				await syncSessionUrl(canonicalSessionId, true);
			} catch {
				chat.error = 'Unable to reach the assistant.';
			}
		})();

		return () => {
			visDestroyed = true;
			// Neither capture mode may leave the mic hot on another route.
			stopConversation();
			stopListening();
			document.documentElement.classList.remove('chat-locked');
			document.body.classList.remove('chat-locked');
			unsubscribeSessionNavigation();
			motionPreference.removeEventListener('change', updateMotionPreference);
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	});
</script>

<svelte:head>
	<title>{activeConversationTitle} - {activeConnectionLabel}</title>
</svelte:head>

<h1 class="sr-only">Chat</h1>

<!-- atmosphere -->
<div class="s-field"></div>
<div class="s-moon"></div>
<div class="s-grain"></div>

<ChatNavbar bind:drawerOpen={navigationOpen} />
<div class="s-bottom-left-controls">
	<span class="s-new-conversation" inert={navigationOpen}><NewChatButton /></span>
	<ChatActivity
		bind:drawerOpen={navigationOpen}
		bind:railOpen={activityRailOpen}
		conversationTitle={activeConversationTitle}
		connectionLabel={activeConnectionLabel}
	/>
</div>

{#if chat.toolLog.length > 0 && activityRailOpen}
	<aside
		class="s-tool-rail"
		id="conversation-activity-rail"
		aria-label={`Activity for ${activeConversationTitle}`}
		inert={navigationOpen}
		transition:fly={{
			x: reducedMotion ? 0 : -24,
			duration: reducedMotion ? 0 : 220
		}}
	>
		<div class="s-activity-context">
			<span>Activity</span>
			<strong>{activeConversationTitle}</strong>
			<small>{activeConnectionLabel}</small>
		</div>
		<ToolLog items={chat.toolLog} showHeading={false} />
	</aside>
{/if}

<!-- conversation thread -->
<main
	class="s-scroll"
	class:has-activity={chat.toolLog.length > 0 && activityRailOpen}
	id="s-scroll"
	aria-label="Chat history"
	inert={navigationOpen}
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
	<div class="s-error-banner" role="alert" inert={navigationOpen}>
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
     Inert while the side panel owns the top layer, like <main> and .s-base —
     the fixed pill must not stay clickable/focusable underneath them. -->
{#if !followingLatest && chat.sending}
	<button
		class="s-jump-latest"
		type="button"
		aria-label="Jump to latest"
		inert={navigationOpen}
		onclick={jumpToLatest}
	>
		↓ latest
	</button>
{/if}

<!-- composer -->
<div
	class="s-base"
	class:has-activity={chat.toolLog.length > 0 && activityRailOpen}
	inert={navigationOpen}
>
	<VoiceStatusStrip thinking={chat.sending} />
	<ChatInput
		bind:draft
		sending={chat.sending}
		questionPending={!!chat.pendingQuestion && chat.pendingQuestion.questions.length === 1}
		onSend={handleSend}
		onStop={() => void chat.stopTurn()}
	/>
</div>

<div class="s-voice-controls" role="toolbar" aria-label="Voice controls" inert={navigationOpen}>
	<button
		class="s-voice-btn"
		class:active={voiceState.ttsAutoEnabled}
		type="button"
		aria-label={voiceState.ttsAutoEnabled
			? 'Turn off spoken responses'
			: 'Turn on spoken responses'}
		title={voiceState.ttsAutoEnabled ? 'Spoken responses are on' : 'Spoken responses are off'}
		aria-pressed={voiceState.ttsAutoEnabled}
		disabled={!ttsEnabled}
		onclick={toggleSpokenResponses}
	>
		{#if voiceState.ttsAutoEnabled}
			<IconSoundOn size={18} />
		{:else}
			<IconSoundOff size={18} />
		{/if}
	</button>
	<button
		class="s-voice-btn"
		class:active={voiceState.conversationActive}
		type="button"
		aria-label={voiceState.conversationActive
			? 'Stop conversation mode'
			: 'Start conversation mode'}
		title={voiceState.conversationActive
			? 'Stop hands-free conversation'
			: 'Start hands-free conversation'}
		aria-pressed={voiceState.conversationActive}
		disabled={!voiceEnabled || !ttsEnabled}
		onclick={toggleConversation}
	>
		<IconWaves size={19} />
	</button>
	<button
		class="s-voice-btn s-dictate-btn"
		class:active={voiceActive}
		class:transcribing={dictationTranscribing}
		type="button"
		aria-label={voiceActive ? 'Stop dictation' : 'Dictate message'}
		title={voiceActive ? 'Stop dictation' : 'Dictate message'}
		aria-pressed={voiceActive}
		disabled={!voiceEnabled}
		onclick={toggleVoice}
	>
		{#if voiceActive && !dictationTranscribing}
			<IconStop size={17} />
		{:else}
			<IconMic size={19} />
		{/if}
	</button>
</div>

<style>
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

	/* ── Conversation ─────────────────────────────────────────────────── */

	.s-scroll {
		position: relative;
		z-index: 10;
		height: calc(100dvh - 64px);
		overflow-y: auto;
		overflow-x: hidden;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
		background: var(--s-paper);
		transition: background var(--s-t-theme) var(--s-ease);
	}

	.s-scroll::-webkit-scrollbar {
		display: none;
	}

	.s-thread {
		max-width: var(--s-measure);
		margin: 0 auto;
		padding: clamp(3rem, 8vh, 5rem) var(--s-frame) clamp(9rem, 20vh, 12rem);
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

	/* ── Composer dock ────────────────────────────────────────────────── */

	.s-base {
		position: fixed;
		z-index: 30;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: var(--s-sp-5) var(--s-frame) max(var(--s-sp-3), env(safe-area-inset-bottom));
		background: linear-gradient(
			to top,
			var(--s-paper) 0%,
			var(--s-paper) 56%,
			color-mix(in srgb, var(--s-paper) 78%, transparent) 82%,
			transparent 100%
		);
		transition: background var(--s-t-theme) var(--s-ease);
		pointer-events: none;
	}

	.s-base > :global(*) {
		pointer-events: auto;
	}

	.s-base :global(.s-send-btn) {
		margin-block: 0;
	}

	.s-voice-controls {
		position: fixed;
		z-index: 70;
		right: max(var(--s-sp-3), env(safe-area-inset-right));
		bottom: max(var(--s-sp-3), env(safe-area-inset-bottom));
		display: flex;
		align-items: center;
		gap: var(--s-sp-1);
	}

	.s-voice-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: var(--s-paper);
		color: var(--s-ink-3);
		cursor: pointer;
	}

	.s-voice-btn:hover,
	.s-voice-btn.active {
		color: var(--s-seal);
	}

	.s-voice-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.s-voice-btn:focus-visible {
		outline: 2px solid var(--s-seal);
		outline-offset: 1px;
	}

	/* ── Error banner ─────────────────────────────────────────────────── */

	.s-error-banner {
		position: fixed;
		z-index: 50;
		bottom: 8rem;
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
		bottom: 8.5rem;
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

	.s-bottom-left-controls {
		position: fixed;
		z-index: 70;
		left: max(var(--s-sp-3), env(safe-area-inset-left));
		bottom: max(var(--s-sp-3), env(safe-area-inset-bottom));
		display: flex;
		align-items: center;
		gap: var(--s-sp-1);
	}

	.s-new-conversation {
		display: inline-flex;
	}

	/* ── Contextual activity ───────────────────────────────────────────── */

	.s-tool-rail {
		position: fixed;
		z-index: 20;
		left: 0;
		top: 64px;
		bottom: 132px;
		width: clamp(220px, 23vw, 300px);
		box-sizing: border-box;
		min-width: 0;
		padding-left: var(--s-chrome-pad);
		padding-right: var(--s-sp-4);
		overflow-y: auto;
		scrollbar-width: none;
		border-right: var(--s-hair) solid var(--s-line-soft);
	}

	.s-tool-rail::-webkit-scrollbar {
		display: none;
	}

	.s-activity-context {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--s-sp-4) 0;
		border-bottom: var(--s-hair) solid var(--s-line-soft);
		margin-bottom: var(--s-sp-3);
	}
	.s-activity-context span {
		color: var(--s-ink-3);
		font-family: var(--s-font-mono);
		font-size: 0.75rem;
	}
	.s-activity-context strong {
		overflow: hidden;
		color: var(--s-ink);
		font-size: 0.875rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.s-activity-context small {
		color: var(--s-ink-3);
		font-size: 0.75rem;
	}

	@media (min-width: 1101px) {
		.s-scroll.has-activity {
			padding-left: clamp(220px, 23vw, 300px);
		}
		.s-base.has-activity {
			left: clamp(220px, 23vw, 300px);
		}
	}

	@media (max-width: 1100px) {
		.s-tool-rail {
			display: none;
		}
	}

	@media (max-width: 999px) {
		.s-scroll {
			height: calc(100dvh - 112px);
		}
	}

	@media (max-width: 479px) {
		.s-scroll {
			height: calc(100dvh - 144px);
		}
	}

	@media (max-width: 720px) {
		.s-voice-controls {
			flex-direction: column;
		}

		.s-thread {
			padding-top: 4rem;
			padding-bottom: 10rem;
		}

		:global(.master-words),
		:global(.you-words) {
			max-width: 92%;
		}

		.s-base {
			padding-top: var(--s-sp-4);
			padding-left: calc(max(var(--s-sp-3), env(safe-area-inset-left)) + 104px);
			padding-right: calc(max(var(--s-sp-3), env(safe-area-inset-right)) + 52px);
		}
	}

	@media (max-height: 34rem) {
		.s-thread {
			padding-top: 3rem;
			padding-bottom: 8.5rem;
		}
	}
</style>
