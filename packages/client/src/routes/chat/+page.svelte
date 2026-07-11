<script lang="ts">
  // /chat — the client chat surface (P5b item 3, #555), adapted from
  // packages/ui routes/chat onto the direct per-connection transport
  // (plan §6.11: no proxy, no host APIs). Voice stays host-chat-only for
  // now (plan §12.2 decision (b)) — everything else in the §12.2 text-chat
  // parity subset lives here.
  //
  // review 2026-07-10 fixes (this file is the "UI half" of each):
  //   §B2 — live SSE streaming: reactive state comes from
  //     $lib/chat/chat-controller.js, which opens transport.subscribeEvents()
  //     once and renders `pendingText` incrementally instead of a blocking
  //     "Thinking…" wait.
  //   §B3 — stop button wired to controller.stop() (abortTurn + a local
  //     AbortController); ChatInput never disables the composer while
  //     sending (see ChatInput.svelte, §B8).
  //   §B5 — selectSession()/mount load real history via
  //     controller.selectSession() (transport.getSessionMessages()); the
  //     old history-unavailable disclaimer note is gone. reconnect() never
  //     touches the transcript.
  //   §B13 — autoscroll follows the ported, unit-tested follow-state module
  //     ($lib/chat/autoscroll.js) instead of an unconditional scrollTo; a
  //     "↓ latest" pill appears when the user has scrolled away mid-stream.
  //   §B16 — a visibilitychange handler re-probes the connection and
  //     refreshes the session list when the tab regains focus.
  //   §G1 — the thread is an aria-live role="log" region; a persistent
  //     status element (mirroring the host app's s-pending/s-loading
  //     pattern) stays mounted and swaps its text rather than being
  //     inserted/removed around the reply.
  //   §G4 — the active session row gets aria-current + an sr-only
  //     "(current)" suffix (border color alone doesn't reach screen readers).
  //   §B4 — PermissionCard/QuestionCard (copied from packages/ui, adapted to
  //     chat-controller's own pending-ask types) surface tool-permission
  //     requests and structured questions instead of silently wedging the
  //     turn for 150s.
  //   §B9 — ToolLog renders `pendingToolStates` (live) plus every entry's
  //     captured `toolStates` (history), deduped by id, instead of an opaque
  //     wait during long tool-running turns.
  //   §B14 — below 44rem the sessions list moves into a togglable drawer
  //     built on the ui-kit Drawer (G3's promoted focus-trap) instead of
  //     being unreachable `display:none` with no alternative path.
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import IconAdd from '@openpalm/ui-kit/components/icons/IconAdd.svelte';
  import IconConversations from '@openpalm/ui-kit/components/icons/IconConversations.svelte';
  import Drawer from '@openpalm/ui-kit/components/common/Drawer.svelte';
  import ChatInput from '$lib/components/chat/ChatInput.svelte';
  import ChatTurn from '$lib/components/chat/ChatTurn.svelte';
  import PermissionCard from '$lib/components/chat/PermissionCard.svelte';
  import QuestionCard from '$lib/components/chat/QuestionCard.svelte';
  import ToolLog from '$lib/components/chat/ToolLog.svelte';
  import { getClientBoot } from '$lib/boot.js';
  import { createTransport, type Transport } from '$lib/transport/index.js';
  import type { ConnectionEntry } from '$lib/connections/index.js';
  import { createChatController, type ChatControllerState } from '$lib/chat/chat-controller.js';
  import type { ToolStateSnapshot } from '$lib/transport/index.js';
  import { renderMarkdown } from '$lib/markdown.js';
  import { nextFollowState } from '$lib/chat/autoscroll.js';

  let connection = $state<ConnectionEntry | null>(null);
  let transport: Transport | null = null;
  let controller: ReturnType<typeof createChatController> | null = null;

  // Mirrors controller.getState() into local $state on every notification —
  // the controller itself is plain TS (bun-test friendly, see
  // tests/chat-controller.test.ts), so the page is a thin subscribing view.
  let chatState = $state<ChatControllerState>({
    sessions: [],
    sessionId: null,
    entries: [],
    sending: false,
    pendingText: '',
    pendingToolStates: [],
    pendingPermission: null,
    pendingQuestion: null,
    connected: false,
    error: '',
    lastFailedText: '',
  });

  let threadEl = $state<HTMLElement | undefined>();
  let scrollAnchorEl = $state<HTMLDivElement | undefined>();

  // ── B14 small-screen sessions drawer ────────────────────────────────────
  // Below 44rem the `.sessions` aside is display:none (see the styles below)
  // — this drawer is the reachable alternative (mouse, touch, keyboard, and screen
  // reader alike), built on the ui-kit Drawer so it inherits G3's promoted
  // focus-trap: focus moves in on open, Tab is trapped, Escape closes, and
  // focus returns to the toggle button on close.
  let sessionsDrawerOpen = $state(false);

  function openSessionsDrawer(): void {
    sessionsDrawerOpen = true;
  }
  function closeSessionsDrawer(): void {
    sessionsDrawerOpen = false;
  }

  // ── B9 tool-activity visibility ─────────────────────────────────────────
  // Every entry's captured toolStates (history) plus the in-flight turn's
  // pendingToolStates (live), deduped by id so a keyed {#each} never
  // collides across the history/live boundary (mirrors 455d8728 chat-state's
  // `toolLog` getter).
  const toolLogItems = $derived.by((): ToolStateSnapshot[] => {
    const seen = new Set<string>();
    const out: ToolStateSnapshot[] = [];
    const push = (states: ToolStateSnapshot[] | undefined): void => {
      if (!states) return;
      for (const tool of states) {
        if (seen.has(tool.id)) continue;
        seen.add(tool.id);
        out.push(tool);
      }
    };
    for (const entry of chatState.entries) {
      push((entry as { toolStates?: ToolStateSnapshot[] }).toolStates);
    }
    push(chatState.pendingToolStates);
    return out;
  });

  // ── B4 permission/question replies ──────────────────────────────────────
  // The '' branch of `decision` only occurs before a reply has been chosen
  // (status 'pending'), never while 'submitting' — but the union type
  // doesn't encode that, so it's narrowed explicitly here for PermissionCard's
  // narrower prop type.
  const permissionActionInFlight = $derived.by((): 'once' | 'always' | 'reject' | null => {
    const permission = chatState.pendingPermission;
    if (permission?.status !== 'submitting') return null;
    return permission.decision || null;
  });

  function handlePermissionReply(reply: 'once' | 'always' | 'reject'): void {
    void controller?.answerPermission(reply);
  }

  function handleQuestionOption(label: string): void {
    void controller?.answerQuestion(label);
  }

  function handleQuestionDraft(index: number, value: string): void {
    controller?.setQuestionAnswer(index, value);
  }

  function handleQuestionSubmit(): void {
    void controller?.answerQuestion();
  }

  function handleQuestionReject(): void {
    void controller?.rejectQuestion();
  }

  // ── B13 autoscroll follow-state ─────────────────────────────────────────
  let followingLatest = $state(true);

  function onFollowChange(following: boolean): void {
    followingLatest = following;
  }

  function scrollToLatest(): void {
    const reduceMotion =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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

  /** Ported from packages/ui routes/chat/+page.svelte's autoscroll action (§B13). */
  function autoscroll(node: HTMLElement, params: AutoscrollParams): { destroy(): void } {
    const scroller = node.closest('.thread') as HTMLElement | null;
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
        typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      queueMicrotask(() => scrollAnchorEl?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }));
    });
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    return {
      destroy() {
        observer.disconnect();
        scroller?.removeEventListener('scroll', handleScroll);
      },
    };
  }

  // ── G1 persistent status text ───────────────────────────────────────────
  const statusText = $derived(
    chatState.sending && !chatState.pendingText && !chatState.pendingPermission && !chatState.pendingQuestion
      ? 'Thinking…'
      : chatState.error
        ? chatState.error
        : ''
  );

  function handleReachabilityProbe(reachable: boolean): void {
    if (!controller) return;
    if (reachable) void controller.refreshSessions();
    else controller.setError('Assistant is not reachable. Try reconnecting.');
  }

  onMount(() => {
    let destroyed = false;

    void (async () => {
      const { store, secrets } = await getClientBoot();
      const active = (await store.getActive()) ?? (await store.list())[0] ?? null;
      if (!active) {
        await goto('/connections/new', { replaceState: true });
        return;
      }
      if (destroyed) return;
      connection = active;
      const auth = await secrets.resolveAuth(active);
      // Re-check after the resolveAuth await (review 2026-07-11 seam 4): an
      // unmount during this WebCrypto decrypt must not still create/init the
      // controller below — that would open a self-reconnecting
      // subscribeEvents() stream with no teardown path (the earlier
      // `destroyed` check above is stale by the time this line runs).
      if (destroyed) return;
      transport = createTransport({ baseUrl: active.url, auth });
      controller = createChatController(transport);
      controller.subscribe(() => {
        if (!controller) return;
        chatState = { ...controller.getState() };
        void scrollIfFollowing();
      });
      await controller.init();
    })();

    // §B16: an OS/tab-switch reachability probe. Assistant outages are
    // otherwise invisible until the next send times out.
    function handleVisibilityChange(): void {
      if (destroyed || document.visibilityState !== 'visible' || !transport) return;
      void transport
        .probeHealth()
        .then((result) => handleReachabilityProbe(result.state === 'accessible' || result.state === 'unauthorized'));
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      destroyed = true;
      controller?.destroy();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  async function scrollIfFollowing(): Promise<void> {
    if (!followingLatest) return;
    await tick();
    const reduceMotion =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollAnchorEl?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function selectSession(id: string): void {
    void controller?.selectSession(id);
  }

  function newSession(): void {
    controller?.newSession();
  }

  function send(text: string): void {
    void controller?.send(text);
  }

  function stop(): void {
    void controller?.stop();
  }

  function retryFailedSend(): void {
    void controller?.retryFailedSend();
  }

  function reconnect(): void {
    void controller?.reconnect();
  }

  function sessionLabel(session: { title: string }): string {
    return session.title || 'Untitled';
  }
</script>

<svelte:head>
  <title>Chat — OpenPalm</title>
</svelte:head>

{#snippet sessionsList()}
  <div class="sessions-head">
    <span class="sessions-title">Sessions</span>
    <!-- F1 (review 2026-07-11): the controller now cancels an in-flight turn
         cleanly on newSession()/selectSession() (aborts the POST, drops the
         old turn's SSE deltas), but disabling these while sending too avoids
         a mid-abort visual flash and accidental rapid-fire switching. -->
    <button
      type="button"
      class="new-chat"
      onclick={newSession}
      aria-label="New chat"
      disabled={chatState.sending}
    >
      <IconAdd size={14} />
    </button>
  </div>
  <ul>
    {#each chatState.sessions as session (session.id)}
      <li>
        <button
          type="button"
          class="session"
          class:current={session.id === chatState.sessionId}
          aria-current={session.id === chatState.sessionId ? 'true' : undefined}
          onclick={() => selectSession(session.id)}
          disabled={chatState.sending && session.id !== chatState.sessionId}
        >
          {sessionLabel(session)}{#if session.id === chatState.sessionId}<span class="sr-only"> (current)</span>{/if}
        </button>
      </li>
    {:else}
      <li class="empty">No sessions yet.</li>
    {/each}
  </ul>
  {#if connection}
    <a class="connection-note" href="/connections" title={connection.url}>
      via {connection.label}
    </a>
  {/if}
{/snippet}

<!-- G2/B14 (review 2026-07-10): this toggle lives OUTSIDE the `inert`-guarded
     `.chat` div below on purpose — it's the drawer's own invoker, and the
     ui-kit Drawer's focus-trap (G3) restores focus to it BY REFERENCE when
     the drawer closes (Escape/scrim/Close button). Nesting it inside `.chat`
     used to mean "close the drawer" and "make the invoker interactive again"
     raced within the same reactive update: a synchronous `.focus()` call
     against a button still covered by `inert={true}` silently no-ops to
     `<body>` (caught by the G2 Playwright suite's 375px keyboard-traversal
     spec — the same class of bug as the connections page's vanishing
     "+ Add connection" invoker). -->
<div class="mobile-sessions-bar">
  <button
    type="button"
    class="sessions-toggle"
    aria-haspopup="dialog"
    aria-expanded={sessionsDrawerOpen}
    onclick={openSessionsDrawer}
  >
    <IconConversations size={16} />
    <span>Sessions</span>
  </button>
</div>

<!-- B14: the rest of the page is inert while the small-screen sessions
     drawer owns the top layer (its own focus trap + Escape close come from
     the ui-kit Drawer/G3 focus-trap). -->
<div class="chat" inert={sessionsDrawerOpen}>
  <aside class="sessions" aria-label="Sessions">
    {@render sessionsList()}
  </aside>

  <section class="thread-pane">
    <!-- role="log": a div, not <main> — <main> already carries the implicit
         "main" landmark, and role="log" would override (not add to) it. -->
    <div class="thread" bind:this={threadEl} role="log" aria-label="Chat history">
      <div use:autoscroll={{ isFollowing: () => followingLatest, onFollowChange }}>
        {#each chatState.entries as entry (entry.id)}
          <ChatTurn {entry} />
        {/each}

        {#if chatState.sending}
          {#if chatState.pendingText}
            <div class="turn master">
              <div class="master-words settled">
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown uses markdown-it with html:false; see ChatTurn.svelte -->
                <div class="markdown-body">{@html renderMarkdown(chatState.pendingText)}</div>
              </div>
            </div>
          {/if}

          {#if chatState.pendingPermission}
            <PermissionCard
              permission={chatState.pendingPermission}
              actionInFlight={permissionActionInFlight}
              onReply={handlePermissionReply}
            />
          {/if}

          {#if chatState.pendingQuestion}
            <QuestionCard
              question={chatState.pendingQuestion}
              onOption={handleQuestionOption}
              onSelect={(index, label) => controller?.setQuestionAnswer(index, label)}
              onDraft={handleQuestionDraft}
              onSubmit={handleQuestionSubmit}
              onReject={handleQuestionReject}
            />
          {/if}
        {/if}

        <div bind:this={scrollAnchorEl} aria-hidden="true" style="height:1px"></div>
      </div>

      <!-- G1: persistent status element — always mounted, text swaps, so a
           screen reader gets a completion signal instead of a silent wait. -->
      <div class="s-status" aria-live="polite">{statusText}</div>
    </div>

    {#if toolLogItems.length > 0}
      <aside class="activity-rail" aria-label="Assistant activity">
        <ToolLog items={toolLogItems} />
      </aside>
    {/if}

    {#if !followingLatest && chatState.sending}
      <button class="jump-latest" type="button" aria-label="Jump to latest" onclick={jumpToLatest}>
        ↓ latest
      </button>
    {/if}

    {#if chatState.error}
      <div class="alert" role="alert">
        <span>{chatState.error}</span>
        {#if chatState.lastFailedText}
          <button type="button" class="alert-action" onclick={retryFailedSend}>retry</button>
        {/if}
        <button type="button" class="alert-action" onclick={reconnect}>reconnect</button>
      </div>
    {/if}

    <div class="composer-row">
      <ChatInput sending={chatState.sending} onSend={send} onStop={stop} />
    </div>
  </section>
</div>

<!-- B14: small-screen sessions drawer — same session list content as the
     `.sessions` aside (display:none below 44rem), reachable via the toggle
     button above. Rendered outside `.chat` so its fixed-position scrim/panel
     (see Drawer.svelte) sit above the now-inert page. -->
<Drawer open={sessionsDrawerOpen} title="Sessions" onClose={closeSessionsDrawer}>
  {@render sessionsList()}
</Drawer>

<style>
  .chat {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .sessions {
    width: 15rem;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: var(--s-hair) solid var(--s-line);
    padding: var(--s-sp-4) var(--s-sp-3);
    gap: var(--s-sp-3);
  }

  @media (max-width: 44rem) {
    .sessions {
      display: none;
    }
  }

  /* B14: the toggle that opens the small-screen sessions drawer — the
     opposite breakpoint from `.sessions` above, so exactly one of the two
     session-access paths is present at any width. */
  .mobile-sessions-bar {
    display: none;
  }

  @media (max-width: 44rem) {
    .mobile-sessions-bar {
      display: flex;
      padding: var(--s-sp-2) clamp(1rem, 6vw, 4rem) 0;
    }
  }

  .sessions-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    appearance: none;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: none;
    color: var(--s-ink-2);
    cursor: pointer;
    min-height: 44px;
    padding: 0.35rem 0.7rem;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
  }

  .sessions-toggle:hover {
    color: var(--s-ink);
    border-color: var(--s-seal);
  }

  .activity-rail {
    border-top: var(--s-hair) solid var(--s-line);
    padding: var(--s-sp-3) clamp(1rem, 6vw, 4rem);
    max-height: 12rem;
    overflow-y: auto;
  }

  .sessions-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .sessions-title {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .new-chat {
    appearance: none;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: none;
    color: var(--s-ink-3);
    cursor: pointer;
    padding: 4px 6px;
    display: inline-flex;
  }

  .new-chat:hover {
    color: var(--s-ink);
    border-color: var(--s-seal);
  }

  .new-chat:disabled,
  .session:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .sessions ul {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .session {
    width: 100%;
    text-align: left;
    appearance: none;
    background: none;
    border: 0;
    border-left: 2px solid transparent;
    color: var(--s-ink-2);
    font: inherit;
    font-size: var(--s-type-deed);
    padding: 0.35rem 0.5rem;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session:hover {
    color: var(--s-ink);
  }

  .session.current {
    color: var(--s-ink);
    border-left-color: var(--s-seal);
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
    border: 0;
  }

  .empty {
    color: var(--s-ink-3);
    font-size: var(--s-type-deed);
    padding: 0.35rem 0.5rem;
  }

  .connection-note {
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .connection-note:hover {
    color: var(--s-ink);
  }

  .thread-pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    position: relative;
  }

  .thread {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: var(--s-sp-5) clamp(1rem, 6vw, 4rem);
  }

  .thread > div:first-child {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-5);
  }

  .s-status {
    display: flex;
    justify-content: center;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    min-height: 1.2em;
  }

  .jump-latest {
    position: absolute;
    bottom: 6.5rem;
    left: 50%;
    transform: translateX(-50%);
    appearance: none;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 999px;
    background: var(--s-paper);
    color: var(--s-ink-2);
    padding: 0.4rem 0.9rem;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    cursor: pointer;
  }

  .jump-latest:hover {
    color: var(--s-ink);
    border-color: var(--s-seal);
  }

  .alert {
    margin: 0 clamp(1rem, 6vw, 4rem) var(--s-sp-3);
    padding: var(--s-sp-3);
    border-radius: 2px;
    color: var(--s-error);
    border: 1px solid color-mix(in srgb, var(--s-error) 25%, transparent);
    background: color-mix(in srgb, var(--s-error) 8%, transparent);
    display: flex;
    align-items: center;
    gap: var(--s-sp-3);
  }

  .alert-action {
    appearance: none;
    border: 1px solid currentColor;
    border-radius: 2px;
    background: none;
    color: inherit;
    font: inherit;
    padding: 0.15rem 0.6rem;
    cursor: pointer;
  }

  .composer-row {
    display: flex;
    justify-content: center;
    padding: var(--s-sp-3) var(--s-sp-4) var(--s-sp-5);
  }
</style>
