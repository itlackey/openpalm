<script lang="ts">
  import Spinner from '@openpalm/ui-kit/components/common/Spinner.svelte';
  import SessionTitle from '$lib/components/chat/SessionTitle.svelte';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { formatRelativeTime, formatDateTime } from '$lib/format-date.js';

  // The session chooser body. Rendered both inside the navbar drawer (small
  // screens) and inline in the chat side panel (large screens). Lazy-loads the
  // session list on mount if the active endpoint hasn't been fetched yet.
  interface Props {
    /** Called after a session is opened or started (e.g. to close the drawer). */
    onChosen?: () => void;
    /** Hide the internal new-session button (use when the parent already provides one). */
    hideNewBtn?: boolean;
  }
  let { onChosen, hideNewBtn = false }: Props = $props();

  const SESSION_LIST_CAP = 50;
  let showAll = $state(false);

  const active = $derived(endpointsService.active);
  const endpointState = $derived(active ? (chat.byEndpoint.get(active.id) ?? null) : null);
  const sessions = $derived(endpointState?.sessions ?? []);
  const loading = $derived(endpointState?.sessionsLoading ?? false);
  const error = $derived(endpointState?.sessionsError ?? '');
  const activeSessionId = $derived(chat.activeSessionId);

  const visibleSessions = $derived(showAll ? sessions : sessions.slice(0, SESSION_LIST_CAP));
  const overflowCount = $derived(Math.max(0, sessions.length - SESSION_LIST_CAP));

  import { onMount } from 'svelte';

  onMount(() => {
    if (active && !endpointState?.sessionsLoaded && !loading) {
      void chat.loadSessions();
    }
  });

  async function pick(id: string): Promise<void> {
    if (chat.sending) return;
    await chat.openSession(id);
    onChosen?.();
  }

  async function startNew(): Promise<void> {
    if (chat.sending) return;
    await chat.startNewSession();
    onChosen?.();
  }

  async function retry(): Promise<void> {
    await chat.loadSessions();
  }
</script>

<div class="session-body">
  {#if chat.sending}
    <div class="notice">Wait for the current reply to finish before switching.</div>
  {/if}

  {#if !endpointState || loading}
    <div class="empty"><Spinner size={12} /><span>Loading sessions…</span></div>
  {:else if error}
    <div class="list-error">
      <span>{error}</span>
      <button type="button" class="retry-btn" onclick={retry}>Retry</button>
    </div>
  {:else if sessions.length === 0}
    <div class="empty">No sessions yet. Start the first one.</div>
  {:else}
    <div class="session-list" role="group" aria-label="Sessions">
      {#each visibleSessions as s (s.id)}
        <button
          type="button"
          class="list-item session-item"
          class:active={s.id === activeSessionId}
          aria-current={s.id === activeSessionId ? 'true' : undefined}
          onclick={() => pick(s.id)}
          disabled={chat.sending}
          title={formatDateTime(s.updatedAt)}
        >
          <span class="item-text">
            <span class="item-label"><SessionTitle title={s.title} />{#if s.id === activeSessionId}<span class="sr-only"> (current)</span>{/if}</span>
            <span class="item-meta">{formatRelativeTime(s.updatedAt)}</span>
          </span>
        </button>
      {/each}
    </div>
    {#if !showAll && overflowCount > 0}
      <button type="button" class="show-all" onclick={() => (showAll = true)}>
        Show all ({overflowCount} more)
      </button>
    {/if}
  {/if}

  {#if !hideNewBtn}
    <div class="divider"></div>
    <button type="button" class="list-item new-btn" onclick={startNew} disabled={chat.sending}>
      <span class="check" aria-hidden="true">+</span>
      <span class="item-text"><span class="item-label">New session</span></span>
    </button>
  {/if}
</div>

<style>
  .session-body {
    display: flex;
    flex-direction: column;
    gap: 0;
    min-height: 0;
  }

  .list-item {
    display: flex;
    align-items: flex-start;
    gap: var(--s-sp-2);
    width: 100%;
    padding: var(--s-sp-2) var(--s-sp-3);
    background: none;
    border: 0;
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    border-radius: 0;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--s-ink-3);
    transition: color 120ms ease;
  }
  .list-item:hover:not(:disabled),
  .list-item:focus-visible {
    color: var(--s-ink-2);
  }
  .list-item:focus-visible {
    outline: var(--s-hair) solid var(--s-line);
    outline-offset: -1px;
  }
  .list-item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* Active row: left seal accent hairline */
  .list-item.active {
    color: var(--s-ink-2);
    border-left: 2px solid var(--s-seal);
    padding-left: calc(var(--s-sp-3) - 2px);
  }

  /* New session button — hairline bordered, mono label */
  .new-btn {
    background: none;
    color: var(--s-ink-3);
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 0;
    justify-content: center;
    margin: var(--s-sp-3) var(--s-sp-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
  }
  .new-btn:hover:not(:disabled) {
    color: var(--s-ink-2);
    border-color: var(--s-line);
  }
  .new-btn:focus-visible {
    outline: var(--s-hair) solid var(--s-line);
    outline-offset: 2px;
  }
  .new-btn .check,
  .new-btn .item-label {
    color: inherit;
  }

  .check {
    flex-shrink: 0;
    width: 14px;
    text-align: center;
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

  .item-text {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex: 1;
    min-width: 0;
  }

  /* Session title — display font, navigation size (not deed/tool scale) */
  .item-label {
    font-family: var(--s-font-display);
    font-size: clamp(0.9rem, 2.2vw, 1.05rem);
    font-weight: 400;
    color: var(--s-ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Meta / timestamp — mono, small, muted */
  .item-meta {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-3);
  }

  .divider {
    height: var(--s-hair);
    margin: var(--s-sp-2) 0;
    background: var(--s-line);
  }

  .session-list {
    overflow-y: auto;
    min-height: 0;
  }

  .empty,
  .list-error {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    padding: var(--s-sp-2) var(--s-sp-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-3);
  }
  .list-error {
    color: var(--s-seal);
  }
  .list-error span:first-child {
    flex: 1;
  }

  .retry-btn {
    padding: 2px 8px;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    border: var(--s-hair) solid var(--s-seal);
    border-radius: 2px;
    background: none;
    color: var(--s-seal);
    cursor: pointer;
  }
  .retry-btn:hover {
    background: var(--s-seal);
    color: var(--s-paper);
  }

  .notice {
    margin: 0 0 var(--s-sp-2);
    padding: var(--s-sp-2) var(--s-sp-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-3);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }

  .show-all {
    width: 100%;
    padding: var(--s-sp-2) var(--s-sp-3);
    background: none;
    border: 0;
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    text-align: left;
    cursor: pointer;
    transition: color 120ms ease;
  }
  .show-all:hover {
    color: var(--s-ink-2);
  }
  .show-all:focus-visible {
    outline: var(--s-hair) solid var(--s-line);
    outline-offset: -1px;
  }
</style>
