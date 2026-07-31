<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import { page } from '$app/state';
	import { afterNavigate, goto, replaceState } from '$app/navigation';
	import ChatFooter from '$lib/components/chat/ChatFooter.svelte';
	import ChatInput from '$lib/components/chat/ChatInput.svelte';
	import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
	import ConversationFrame from '$lib/components/chrome/ConversationFrame.svelte';
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
	import { stopConversation, voiceState } from '$lib/voice/voice-state.svelte.js';

	let scrollAnchorEl = $state<HTMLDivElement | undefined>();

	// F7: re-rendering markdown on every SSE delta re-parses the WHOLE
	// accumulated reply each time — O(n²) over a long streamed turn, and each
	// resulting DOM write also re-fires the autoscroll MutationObserver below.
	// Coalesce to at most one re-parse per animation frame; a burst of deltas
	// within a frame collapses into a single render of the latest text. The
	// very first chunk renders immediately so a reply doesn't open with a
	// blank beat before the first frame.
	let renderedPendingHtml = $state('');
	let pendingRenderFrame: number | null = null;
	$effect(() => {
		const text = chat.pendingAssistantText;
		if (!text) {
			if (pendingRenderFrame !== null) {
				cancelAnimationFrame(pendingRenderFrame);
				pendingRenderFrame = null;
			}
			renderedPendingHtml = '';
			return;
		}
		if (pendingRenderFrame !== null) return;
		if (!renderedPendingHtml) {
			renderedPendingHtml = renderMarkdown(text);
			return;
		}
		pendingRenderFrame = requestAnimationFrame(() => {
			pendingRenderFrame = null;
			renderedPendingHtml = renderMarkdown(chat.pendingAssistantText);
		});
	});

	const entriesLoading = $derived(chat.entriesLoading);
	const activeEndpointState = $derived(chat.byEndpoint.get(chat.activeEndpointId));
	const sessionsLoading = $derived(activeEndpointState?.sessionsLoading ?? false);
	const sessionsError = $derived(activeEndpointState?.sessionsError ?? '');
	// `mapAssistantError` (chat/assistant-error.ts) always renders a 401 as this
	// exact literal, so it doubles as a stable, safe-to-match sentinel here —
	// the alternative (attaching a status code end-to-end through a string
	// field) isn't worth it for a two-way branch.
	const SIGN_IN_REQUIRED = 'Sign-in required.';
	const sessionsAuthFailure = $derived(sessionsError === SIGN_IN_REQUIRED);
	// The empty-thread-with-a-live-composer trap (F5): a failed session load
	// with zero rendered messages looks like a healthy, quiet chat rather than
	// an assistant that's still starting up (or unreachable/signed-out).
	const showStartupState = $derived(
		!sessionsLoading && !entriesLoading && chat.entries.length === 0 && sessionsError !== ''
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
	let routeResolutionId = 0;

	// ── Helpers ──────────────────────────────────────────────────────────

	async function reconnect(): Promise<void> {
		chat.error = '';
		// onEndpointChanged always calls loadSessions() internally — no separate call needed.
		await chat.onEndpointChanged(endpointsService.activeId);
	}

	// F6: a 14-day sliding session had no UI control to end it on a shared
	// machine, despite POST /api/auth/logout already existing server-side.
	async function handleSignOut(): Promise<void> {
		try {
			await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
		} catch {
			// Best-effort — land on /login regardless; if the network is down the
			// cookie may already be unusable anyway.
		}
		const redirectTo = encodeURIComponent(`${page.url.pathname}${page.url.search}`);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- static internal route
		await goto(`/login?redirectTo=${redirectTo}`);
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
		const endpointId = endpointsService.activeId;
		const endpointState = chat.byEndpoint.get(endpointId);
		await syncSessionUrl(
			endpointId,
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

	// Composer draft — dictation inserts here instead of auto-sending, so
	// the user reviews spoken text before it goes out.
	let draft = $state('');

	async function syncSessionUrl(
		endpointId: string,
		sessionId: string | null,
		replace: boolean
	): Promise<void> {
		const target = buildChatPath(sessionId, endpointId);
		if (`${page.url.pathname}${page.url.search}` === target) return;
		if (replace) {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- canonical session path built internally
			replaceState(target, page.state);
			return;
		}
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- canonical session path built internally
		await goto(target);
	}

	// Resolve the assistant + session named in the CURRENT URL and reconcile the
	// chat store to it. Runs on initial arrival AND every same-route navigation
	// via afterNavigate — including browser Back/Forward (popstate), which a
	// query-only change does not remount for. Without this the URL/navbar and the
	// rendered transcript desync after Back/Forward. It is idempotent: a session
	// that's already active skips openSession, and syncSessionUrl no-ops when the
	// URL already matches, so the redundant run after an in-app goto() is cheap.
	async function resolveRoute(): Promise<void> {
		const resolutionId = ++routeResolutionId;
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
			// load() shares one in-flight request across concurrent callers, so this
			// awaits the actual settle even when another shell component already owns
			// the load (no busy-wait on the reactive flags).
			await endpointsService.load();
			if (resolutionId !== routeResolutionId) return;
			if (endpointsService.endpoints.length === 0) {
				// PR #571 review P2 (#511): a fresh install launching at /chat (the
				// PWA start_url) with an empty browser connection store must land on
				// the add-connection flow, not on the synthetic unreachable 'default'
				// below. Local discovery gets its chance first, so a machine with a
				// healthy local assistant still lands in chat.
				await endpointsService.localDiscoverySettled();
				if (resolutionId !== routeResolutionId) return;
				if (endpointsService.endpoints.length === 0) {
					// eslint-disable-next-line svelte/no-navigation-without-resolve -- static internal route
					await goto('/connections/new?onboarding=1', { replaceState: true });
					return;
				}
			}
			let endpointId =
				endpointsService.activeId || endpointsService.endpoints[0]?.id || 'default';
			const requestedAssistantExists =
				requestedAssistantId !== null &&
				endpointsService.endpoints.some((endpoint) => endpoint.id === requestedAssistantId);
			if (requestedAssistantExists && requestedAssistantId !== endpointsService.activeId) {
				await endpointsService.activate(requestedAssistantId);
				if (resolutionId !== routeResolutionId) return;
				endpointId = requestedAssistantId;
			} else {
				await chat.onEndpointChanged(endpointId);
				if (resolutionId !== routeResolutionId) return;
			}
			const resolvedEndpointId = endpointsService.activeId;
			if (resolvedEndpointId !== endpointId || chat.activeEndpointId !== resolvedEndpointId) return;
			const endpointState = chat.byEndpoint.get(resolvedEndpointId);
			const requestedAssistantMatchesResolved =
				requestedAssistantId === null || requestedAssistantId === resolvedEndpointId;
			const sessionsAuthoritative = Boolean(
				endpointState?.sessionsLoaded && !endpointState.sessionsError
			);
			const requestedSessionExists =
				sessionsAuthoritative &&
				requestedAssistantMatchesResolved &&
				requestedSessionId !== null &&
				Boolean(endpointState?.sessions.some((session) => session.id === requestedSessionId));
			let canonicalSessionId: string | null = sessionsAuthoritative
				? requestedSessionExists
					? requestedSessionId
					: (endpointState?.activeSessionId ?? endpointState?.sessions[0]?.id ?? null)
				: requestedAssistantMatchesResolved
					? (requestedSessionId ?? endpointState?.activeSessionId ?? null)
					: (endpointState?.activeSessionId ?? null);
			if (requestedSessionExists && requestedSessionId !== chat.activeSessionId) {
				await chat.openSession(requestedSessionId);
				if (resolutionId !== routeResolutionId) return;
			}
			if (beginNewRequested) {
				canonicalSessionId = (await chat.startNewSession()) ?? canonicalSessionId;
				if (resolutionId !== routeResolutionId) return;
			}
			if (
				endpointsService.activeId !== resolvedEndpointId ||
				chat.activeEndpointId !== resolvedEndpointId
			) return;
			await syncSessionUrl(resolvedEndpointId, canonicalSessionId, true);
		} catch {
			if (resolutionId === routeResolutionId) {
				chat.error = 'Unable to reach the assistant.';
			}
		}
	}

	// Fires on initial arrival AND every same-route navigation, incl. browser
	// Back/Forward (popstate) — which a query-only ?session/?assistant change
	// does not remount for — so the store follows the URL. Shallow replaceState
	// (syncSessionUrl) does not trigger this, so there is no feedback loop.
	afterNavigate(() => {
		void resolveRoute();
	});

	// ── Mount ─────────────────────────────────────────────────────────────
	onMount(() => {
		const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
		const updateMotionPreference = (): void => {
			reducedMotion = motionPreference.matches;
		};
		updateMotionPreference();
		motionPreference.addEventListener('change', updateMotionPreference);

		function onKey(e: KeyboardEvent): void {
			// Only end conversation mode on Escape when no drawer is open — an
			// open drawer owns Escape (its focus-trap closes it), and this
			// listener must not also tear down the live conversation on the same
			// keypress.
			if (e.key === 'Escape' && voiceState.conversationActive && !navigationOpen) {
				stopConversation();
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
		const unsubscribeSessionNavigation = onConnectionActivated(async (endpointId) => {
			await tick();
			if (endpointsService.activeId !== endpointId || chat.activeEndpointId !== endpointId) return;
			const endpointState = chat.byEndpoint.get(endpointId);
			await syncSessionUrl(
				endpointId,
				endpointState?.activeSessionId ?? endpointState?.sessions[0]?.id ?? null,
				true
			);
		});

		// Route resolution (assistant + session from the URL) runs via
		// afterNavigate, which fires on this initial mount too — so it is
		// deliberately NOT also invoked here.

		return () => {
			visDestroyed = true;
			unsubscribeSessionNavigation();
			motionPreference.removeEventListener('change', updateMotionPreference);
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			if (pendingRenderFrame !== null) cancelAnimationFrame(pendingRenderFrame);
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

<ConversationFrame bind:drawerOpen={navigationOpen}>
<div class="s-chat-content">
<button class="s-signout" type="button" onclick={() => void handleSignOut()}>sign out</button>
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

		{#if showStartupState}
			<div class="s-startup" role="alert">
				<p class="s-startup-text">
					{sessionsAuthFailure ? 'Sign-in required.' : 'The assistant is still starting up, or unreachable.'}
				</p>
				<p class="s-startup-detail">{sessionsError}</p>
				{#if sessionsAuthFailure}
					<a class="s-startup-action" href={`/login?redirectTo=${encodeURIComponent(`${page.url.pathname}${page.url.search}`)}`}>
						sign in
					</a>
				{:else}
					<button class="s-startup-action" type="button" onclick={() => void chat.loadSessions(true)}>
						retry
					</button>
				{/if}
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
							<div class="markdown-body">{@html renderedPendingHtml}</div>
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
</div>

{#snippet footer()}
<ChatFooter
	bind:draft
	bind:drawerOpen={navigationOpen}
	bind:railOpen={activityRailOpen}
	thinking={chat.sending}
	showConversationActions
	conversationTitle={activeConversationTitle}
	connectionLabel={activeConnectionLabel}
	dictationMode="draft"
>
	{#snippet notice()}
		{#if chat.error}
			<div class="s-error-banner" role="alert">
				<span class="s-error-msg">{chat.error}</span>
				{#if chat.error === SIGN_IN_REQUIRED}
					<!-- A dead-end "reconnect" button can't fix an expired session — the
					     only way out is signing back in. -->
					<a class="s-error-reconnect" href={`/login?redirectTo=${encodeURIComponent(`${page.url.pathname}${page.url.search}`)}`}>
						sign in
					</a>
				{:else}
					{#if chat.lastFailedText}
						<button class="s-error-reconnect" type="button" onclick={retryFailedSend}>retry</button>
					{/if}
					<button class="s-error-reconnect" type="button" onclick={reconnect}>reconnect</button>
				{/if}
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
		{#if !followingLatest && chat.sending}
			<button class="s-jump-latest" type="button" aria-label="Jump to latest" onclick={jumpToLatest}>
				↓ latest
			</button>
		{/if}
	{/snippet}
	{#snippet composer()}
		<ChatInput
			bind:draft
			sending={chat.sending}
			questionPending={!!chat.pendingQuestion && chat.pendingQuestion.questions.length === 1}
			onSend={handleSend}
			onStop={() => void chat.stopTurn()}
		/>
	{/snippet}
</ChatFooter>
{/snippet}
</ConversationFrame>

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
	.s-chat-content {
		position: relative;
		display: flex;
		min-height: 0;
		flex: 1;
	}

	/* Fixed to the content area (not the scrolling thread), so it stays put
	   regardless of scroll position. */
	.s-signout {
		position: absolute;
		z-index: 30;
		top: 0.75rem;
		right: 1rem;
		appearance: none;
		border: var(--s-hair) solid var(--s-line);
		background: var(--s-paper);
		cursor: pointer;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: lowercase;
		color: var(--s-ink-3);
		padding: 0.2rem 0.6rem;
		border-radius: var(--s-radius-seal);
	}

	.s-signout:hover {
		color: var(--s-ink);
	}

	.s-scroll {
		position: relative;
		z-index: 10;
		flex: 1;
		min-height: 0;
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
		padding: clamp(3rem, 8vh, 5rem) var(--s-frame);
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

	/* ── Startup / unreachable state ────────────────────────────────────
	   F5: a failed session load previously rendered nothing on the main
	   surface — a silent empty thread with a live composer above a banner
	   that only exists inside the (closed) conversations drawer. */
	.s-startup {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.6rem;
		padding: 2.5rem 1rem;
		text-align: center;
	}

	.s-startup-text {
		margin: 0;
		font-family: var(--s-font-header);
		font-size: 1.1rem;
		color: var(--s-ink-2);
	}

	.s-startup-detail {
		margin: 0;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-3);
	}

	.s-startup-action {
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
		text-decoration: none;
	}

	.s-startup-action:hover {
		color: var(--s-ink);
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

	/* ── Error banner ─────────────────────────────────────────────────── */

	.s-error-banner {
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

	/* ── Contextual activity ───────────────────────────────────────────── */

	.s-tool-rail {
		position: absolute;
		z-index: 20;
		left: 0;
		top: 0;
		bottom: 0;
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
	}

	@media (max-width: 1100px) {
		.s-tool-rail {
			display: none;
		}
	}

	@media (max-width: 720px) {
		.s-thread {
			padding-top: 4rem;
			padding-bottom: 4rem;
		}

		:global(.master-words),
		:global(.you-words) {
			max-width: 92%;
		}
	}

	@media (max-height: 34rem) {
		.s-thread {
			padding-top: 3rem;
			padding-bottom: 3rem;
		}
	}
</style>
