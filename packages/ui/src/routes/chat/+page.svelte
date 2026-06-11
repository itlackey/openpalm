<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
  import ChatInput from '$lib/components/chat/ChatInput.svelte';
  import ToolStrip from '$lib/components/chat/ToolStrip.svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import EndpointList from '$lib/components/chat/EndpointList.svelte';
  import SessionList from '$lib/components/chat/SessionList.svelte';
  import { stopSpeaking } from '$lib/voice/voice-state.svelte.js';
  import { probeChatBackend } from '$lib/api.js';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import { buildAdvancedPath } from '$lib/chat/navigation.js';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  // Auth is enforced server-side in hooks.server.ts; this page only renders
  // when the visitor is already an authenticated admin.

  // ── Scroll anchor ────────────────────────────────────────────────────
  let scrollAnchorEl = $state<HTMLDivElement | undefined>();

  // ── Loading state for the messages area ───────────────────────────────
  // While the per-endpoint session list is loading we don't know which
  // session to render, so show a skeleton. Same treatment while a chosen
  // session's messages are being fetched.
  const entriesLoading = $derived(chat.entriesLoading);
  const sessionsLoading = $derived(
    chat.byEndpoint.get(chat.activeEndpointId)?.sessionsLoading ?? false
  );

  // ── Helpers ──────────────────────────────────────────────────────────

  async function reconnect(): Promise<void> {
    chat.error = '';
    // Per the multi-endpoint refactor: don't drop session state, re-fetch
    // the list from OpenCode and resume the newest/previous session.
    await chat.loadSessions();
    await chat.onEndpointChanged(endpointsService.activeId);
  }

  async function handleSend(text: string): Promise<void> {
    await chat.send(text);
  }

  async function handlePermissionReply(reply: 'once' | 'always' | 'reject'): Promise<void> {
    await chat.answerPermission(reply);
  }

  async function handleQuestionOption(answer: string): Promise<void> {
    await chat.answerQuestion(answer);
  }

  function handleQuestionDraft(index: number, event: Event): void {
    chat.setQuestionAnswer(index, (event.currentTarget as HTMLInputElement).value);
  }

  async function handleQuestionSubmit(): Promise<void> {
    await chat.answerQuestion();
  }

  async function handleQuestionReject(): Promise<void> {
    await chat.rejectQuestion();
  }

  function scrollToBottom(): void {
    // Use microtask to allow DOM update first
    queueMicrotask(() => {
      scrollAnchorEl?.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // Keep the newest turn in view whenever the rendered transcript changes,
  // including the pending assistant indicator shown during a reply.
  $effect(() => {
    const lastEntry = chat.entries.at(-1);
    const lastEntryContent =
      lastEntry?.type === 'divider'
        ? lastEntry.label
        : lastEntry?.type === 'note'
          ? lastEntry.text
          : lastEntry?.type === 'tool'
            ? lastEntry.toolState.title
            : lastEntry?.text ?? '';

    if (!lastEntry && !entriesLoading && !sessionsLoading && !chat.sending) {
      return;
    }

    lastEntryContent;
    chat.pendingAssistantText;
    chat.pendingToolStates.length;
    chat.pendingPermission?.requestID;
    chat.pendingQuestion?.requestID;
    scrollToBottom();
  });

  function liveStatusText(): string {
    if (chat.pendingPermission) return 'Assistant paused for approval';
    if (chat.pendingQuestion) return 'Assistant is waiting for your answer';
    if (chat.pendingAssistantText) return 'Assistant is responding';
    return 'Assistant is typing';
  }

  function clamp(text: string, max = 160): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  // ── Body scroll lock (chat-page only) ────────────────────────────────
  // The chat layout is exactly viewport-height with internal scroll on the
  // messages area. Suppress body scroll while we're on this page so we
  // don't get a redundant outer scrollbar. $effect cleanup guarantees the
  // class is removed on navigation away, even if SvelteKit's CSS handling
  // doesn't tear down :global rules reliably for adapter-node builds.
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.add('chat-locked');
    document.body.classList.add('chat-locked');
    return () => {
      document.documentElement.classList.remove('chat-locked');
      document.body.classList.remove('chat-locked');
    };
  });

  // ── Visibility-change reconnect ───────────────────────────────────────
  // When the tab regains focus, probe the current backend. (Uses $effect
  // because we need a DOM event subscription with cleanup — this is a
  // legitimate $effect use case, not a state-sync anti-pattern.)
  $effect(() => {
    let destroyed = false;

    function handleVisibilityChange(): void {
      if (destroyed || document.visibilityState !== 'visible') return;
      void (async () => {
        const reachable = await probeChatBackend();
        if (!reachable && !destroyed) {
          chat.error = 'Assistant is not reachable. Try reconnecting.';
        }
      })();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      destroyed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  // ── Mount ─────────────────────────────────────────────────────────────

  onMount(() => {
    void (async () => {
      try {
        advancedModeService.init();
        const requestedSessionId = page.url.searchParams.get('session');
        if (advancedModeService.enabled) {
          await goto(buildAdvancedPath(requestedSessionId), { replaceState: true });
          return;
        }
        // Load endpoint list + sessions for the active endpoint, restoring
        // the most recent session.
        await endpointsService.load();
        await chat.onEndpointChanged(endpointsService.activeId);
        if (requestedSessionId) {
          await chat.openSession(requestedSessionId);
        }
        // Honour the global navbar's "new chat" handshake (?new=1) once the
        // endpoint + sessions are loaded, then drop the param from the URL.
        if (page.url.searchParams.get('new') === '1') {
          await chat.startNewSession();
          await goto('/chat', { replaceState: true });
        }
      } catch {
        chat.error = 'Unable to reach the assistant.';
      }
    })();
  });
</script>

<svelte:head>
  <title>Chat — OpenPalm</title>
</svelte:head>

<Navbar />

<div class="chat-shell">
  <div class="chat-layout">
    <!-- Message history -->
    <section class="messages-area" aria-label="Chat history" aria-live="polite">
      {#if sessionsLoading || entriesLoading}
        <div class="session-loading" aria-live="polite">
          <Spinner />
          <span>Loading messages…</span>
        </div>
      {:else if chat.entries.length === 0}
        <div class="empty-state">
          <p>No messages yet. Send something to begin.</p>
        </div>
      {/if}

      {#each chat.entries as entry (entry.id)}
        <ChatMessage {entry} />
      {/each}

      {#if chat.sending}
        <div class="typing-message" aria-live="polite" aria-label={liveStatusText()}>
          <div class="typing-bubble">
            {#if chat.pendingAssistantText}
              <p class="typing-text typing-text-streaming">{chat.pendingAssistantText}</p>
            {:else}
              <div class="typing-state-row">
                <span class="typing-text">{liveStatusText()}</span>
                {#if !chat.pendingPermission && !chat.pendingQuestion}
                  <span class="typing-indicator" aria-hidden="true">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                  </span>
                {/if}
              </div>
            {/if}

            {#if chat.pendingToolStates.length > 0}
              <ToolStrip
                items={chat.pendingToolStates}
                muted={!!chat.pendingPermission || !!chat.pendingQuestion}
                bordered={true}
                ariaLabel="Assistant tool activity"
              />
            {/if}

            {#if chat.pendingPermission}
              <div class="live-card permission-card" role="group" aria-label="Permission request">
                <div class="live-card-header">
                  <span class="live-card-kicker">Permission request</span>
                  <span class="live-card-title">{chat.pendingPermission.permission}</span>
                </div>
                {#if chat.pendingPermission.detail}
                  <p class="live-card-message">{clamp(chat.pendingPermission.detail)}</p>
                {/if}
                {#if chat.pendingPermission.patterns.length > 0}
                  <div>
                    <span class="live-card-label">Requested now</span>
                    <code class="live-card-code">{chat.pendingPermission.patterns.join(', ')}</code>
                  </div>
                {/if}
                {#if chat.pendingPermission.always.length > 0}
                  <div>
                    <span class="live-card-label">Saved if always allowed</span>
                    <code class="live-card-code">{chat.pendingPermission.always.join(', ')}</code>
                  </div>
                {/if}
                {#if chat.pendingPermission.message}
                  <p class="live-card-message">{chat.pendingPermission.message}</p>
                {/if}
                <div class="live-card-actions">
                  <button class="btn btn-primary btn-sm" type="button" onclick={() => void handlePermissionReply('once')} disabled={chat.pendingPermission.status === 'submitting' || chat.pendingPermission.status === 'resolved'}>
                    Allow this once
                  </button>
                  <button class="btn btn-secondary btn-sm" type="button" onclick={() => void handlePermissionReply('always')} disabled={chat.pendingPermission.status === 'submitting' || chat.pendingPermission.status === 'resolved'}>
                    Always allow matches
                  </button>
                  <button class="btn btn-danger btn-sm" type="button" onclick={() => void handlePermissionReply('reject')} disabled={chat.pendingPermission.status === 'submitting' || chat.pendingPermission.status === 'resolved'}>
                    Deny request
                  </button>
                </div>
              </div>
            {/if}

            {#if chat.pendingQuestion}
              <div class="live-card question-card" role="group" aria-label="Assistant question">
                <div class="live-card-header">
                  <span class="live-card-kicker">Assistant question</span>
                  {#if chat.pendingQuestion.questions.length === 1 && chat.pendingQuestion.questions[0]?.header}
                    <span class="live-card-title">{chat.pendingQuestion.questions[0].header}</span>
                  {:else if chat.pendingQuestion.questions.length > 1}
                    <span class="live-card-title">{chat.pendingQuestion.questions.length} answers required</span>
                  {/if}
                </div>

                {#if chat.pendingQuestion.questions.length === 1 && chat.pendingQuestion.questions[0]}
                  <p class="live-card-question">{chat.pendingQuestion.questions[0].question}</p>
                  {#if chat.pendingQuestion.questions[0].options.length > 0}
                    <div class="question-options">
                      {#each chat.pendingQuestion.questions[0].options as option, index (`${chat.pendingQuestion.requestID}:${index}`)}
                        <button class="btn btn-secondary btn-sm question-option" type="button" onclick={() => void handleQuestionOption(option.label)} disabled={chat.pendingQuestion.status === 'submitting' || chat.pendingQuestion.status === 'answered' || chat.pendingQuestion.status === 'rejected'}>
                          <span>{option.label}</span>
                          {#if option.description}
                            <span class="question-option-description">{option.description}</span>
                          {/if}
                        </button>
                      {/each}
                    </div>
                  {/if}
                  <p class="live-card-hint">Use the composer below to send a custom answer.</p>
                {:else}
                  <div class="multi-question-list">
                    {#each chat.pendingQuestion.questions as question, index (`${chat.pendingQuestion.requestID}:question:${index}`)}
                      <div class="multi-question-item">
                        {#if question.header}
                          <span class="live-card-label">{question.header}</span>
                        {/if}
                        <p class="live-card-question">{question.question}</p>
                        {#if question.options.length > 0}
                          <div class="question-options">
                            {#each question.options as option, optionIndex (`${chat.pendingQuestion.requestID}:${index}:${optionIndex}`)}
                              <button
                                class="btn btn-secondary btn-sm question-option"
                                class:selected-option={chat.pendingQuestion.answers[index] === option.label}
                                type="button"
                                onclick={() => chat.setQuestionAnswer(index, option.label)}
                                disabled={chat.pendingQuestion.status === 'submitting' || chat.pendingQuestion.status === 'answered' || chat.pendingQuestion.status === 'rejected'}
                              >
                                <span>{option.label}</span>
                                {#if option.description}
                                  <span class="question-option-description">{option.description}</span>
                                {/if}
                              </button>
                            {/each}
                          </div>
                        {/if}
                        <input
                          class="question-input"
                          type="text"
                          value={chat.pendingQuestion.answers[index]}
                          placeholder="Type an answer"
                          oninput={(event) => handleQuestionDraft(index, event)}
                          disabled={chat.pendingQuestion.status === 'submitting' || chat.pendingQuestion.status === 'answered' || chat.pendingQuestion.status === 'rejected'}
                        />
                      </div>
                    {/each}
                  </div>
                {/if}

                {#if chat.pendingQuestion.answers.some((answer) => answer)}
                  <code class="live-card-code">{chat.pendingQuestion.answers.filter(Boolean).join(' | ')}</code>
                {/if}
                {#if chat.pendingQuestion.message}
                  <p class="live-card-message">{chat.pendingQuestion.message}</p>
                {/if}
                <div class="live-card-actions">
                  {#if chat.pendingQuestion.questions.length > 1}
                    <button class="btn btn-primary btn-sm" type="button" onclick={() => void handleQuestionSubmit()} disabled={chat.pendingQuestion.status === 'submitting' || chat.pendingQuestion.status === 'answered' || chat.pendingQuestion.status === 'rejected'}>
                      Submit answers
                    </button>
                  {/if}
                  <button class="btn btn-secondary btn-sm" type="button" onclick={() => void handleQuestionReject()} disabled={chat.pendingQuestion.status === 'submitting' || chat.pendingQuestion.status === 'answered' || chat.pendingQuestion.status === 'rejected'}>
                    Can't answer
                  </button>
                </div>
              </div>
            {/if}
          </div>
          <span class="typing-meta">Assistant</span>
        </div>
      {/if}

      <div bind:this={scrollAnchorEl} aria-hidden="true"></div>
    </section>

    <!-- Error / reconnect banner -->
    {#if chat.error}
      <div class="chat-error-banner" role="alert">
        <span>{chat.error}</span>
        <button class="reconnect-btn" type="button" onclick={reconnect}>
          Reconnect
        </button>
        <button
          class="dismiss-btn"
          type="button"
          aria-label="Dismiss error"
          onclick={() => { chat.error = ''; }}
        >
          &times;
        </button>
      </div>
    {/if}

    <!-- Input area — always at the bottom. -->
    <ChatInput
      sending={chat.sending}
      questionPending={!!chat.pendingQuestion && chat.pendingQuestion.questions.length === 1}
      onSend={handleSend}
    />
  </div>

  <!-- Right-side panel (≥1024px): assistant chooser + session list. Replaces the
       navbar drawer triggers at this width. -->
  <aside class="chat-side" aria-label="Assistant and sessions">
    <section class="side-section">
      <h2 class="side-heading">Assistant</h2>
      <EndpointList />
    </section>
    <section class="side-section side-sessions">
      <h2 class="side-heading">Sessions</h2>
      <SessionList />
    </section>
  </aside>
</div>

<style>
  /* Body lock is applied via a class added in a $effect (see <script>)
     instead of `:global(body)` here, because Svelte's :global rules don't
     reliably detach on client-side navigation in adapter-node — the
     stylesheet for a page can stay loaded after we leave it, breaking
     scroll on other pages. The class-based approach guarantees cleanup. */

  /* Shell splits the viewport into the chat column and the optional side panel. */
  .chat-shell {
    display: flex;
    height: calc(100dvh - var(--nav-height));
    margin: 0;
  }

  .chat-layout {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  /* Right-side panel — hidden until there's room for it alongside the chat. */
  .chat-side {
    display: none;
  }
  @media (min-width: 1024px) {
    .chat-side {
      display: flex;
      flex-direction: column;
      width: 20rem;
      flex-shrink: 0;
      height: 100%;
      border-left: 1px solid var(--color-border);
      background: var(--color-bg);
      overflow: hidden;
    }
  }

  .side-section {
    padding: var(--space-4) var(--space-3);
    border-bottom: 1px solid var(--color-border);
    min-height: 0;
  }
  /* Sessions section fills the remaining height and scrolls internally. */
  .side-sessions {
    flex: 1;
    display: flex;
    flex-direction: column;
    border-bottom: none;
    overflow-y: auto;
  }

  .side-heading {
    margin: 0 0 var(--space-2);
    padding: 0 var(--space-3);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
  }

  .messages-area {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-5) var(--space-4);
    scroll-behavior: smooth;
    /* Center a contained reading column so turns never fly to the screen edges. */
    align-items: center;
  }

  .messages-area > :global(*) {
    width: 100%;
    max-width: var(--chat-column); /* centered conversation column, shared with the composer */
  }

  .empty-state {
    margin: auto;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: var(--text-base);
    padding: var(--space-8);
  }

  .session-loading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    padding: var(--space-4);
    margin: auto;
  }

  .typing-message {
    width: 100%;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
  }

  .typing-bubble {
    max-width: 85%;
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg-tertiary);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    border-bottom-left-radius: var(--radius-sm);
    line-height: var(--leading-normal);
  }

  .typing-text {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0;
  }

  .typing-text-streaming {
    color: var(--color-text);
    white-space: pre-wrap;
  }

  .typing-state-row {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .typing-indicator {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .typing-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--color-text-secondary);
    opacity: 0.35;
    animation: typing-bounce 1.1s infinite ease-in-out;
  }

  .typing-dot:nth-child(2) {
    animation-delay: 0.16s;
  }

  .typing-dot:nth-child(3) {
    animation-delay: 0.32s;
  }

  .typing-meta {
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .live-card {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
  }

  .live-card-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .live-card-kicker {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-tertiary);
  }

  .live-card-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .live-card-label {
    display: block;
    margin-bottom: 4px;
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .live-card-question,
  .live-card-message,
  .live-card-hint {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .live-card-message,
  .live-card-hint {
    color: var(--color-text-secondary);
  }

  .live-card-code {
    display: inline-block;
    max-width: 100%;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--color-bg-tertiary);
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .live-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .question-options {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .multi-question-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .multi-question-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--color-border);
  }

  .multi-question-item:first-child {
    padding-top: 0;
    border-top: 0;
  }

  .question-option {
    justify-content: flex-start;
    text-align: left;
    white-space: normal;
  }

  .question-option.selected-option {
    border-color: var(--color-primary);
    background: var(--color-primary-subtle);
    color: var(--color-text);
  }

  .question-option-description {
    color: var(--color-text-secondary);
    font-weight: var(--font-normal);
  }

  .question-input {
    width: 100%;
    min-height: 40px;
    padding: 0 var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
  }

  .question-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
  }

  @keyframes typing-bounce {
    0%,
    80%,
    100% {
      transform: translateY(0);
      opacity: 0.35;
    }

    40% {
      transform: translateY(-3px);
      opacity: 0.95;
    }
  }

  .chat-error-banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: var(--color-danger-bg);
    border-top: 1px solid rgba(250, 82, 82, 0.25);
    font-size: var(--text-sm);
    color: var(--color-danger);
  }

  .chat-error-banner span:first-child {
    flex: 1;
  }

  .reconnect-btn {
    padding: 3px 10px;
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--color-danger);
    cursor: pointer;
    white-space: nowrap;
    transition: all var(--transition-fast);
  }

  .reconnect-btn:hover {
    background: var(--color-danger);
    color: #fff;
  }

  .dismiss-btn {
    width: 24px;
    height: 24px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--color-danger);
    cursor: pointer;
    font-size: var(--text-lg);
    line-height: 1;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }

  .dismiss-btn:hover {
    background: rgba(250, 82, 82, 0.15);
  }

  @media (max-width: 768px) {
    .messages-area {
      padding: var(--space-3) var(--space-4);
    }
  }
</style>
