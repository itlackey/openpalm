<script lang="ts">
  import { onMount } from 'svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  // The session chooser body. Rendered both inside the navbar drawer (small
  // screens) and inline in the chat side panel (large screens). Lazy-loads the
  // session list on mount if the active endpoint hasn't been fetched yet.
  interface Props {
    /** Called after a session is opened or started (e.g. to close the drawer). */
    onChosen?: () => void;
  }
  let { onChosen }: Props = $props();

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

  onMount(() => {
    if (active && !endpointState?.sessionsLoaded && !loading) {
      void chat.loadSessions();
    }
  });

  /** Tiny relative-time helper. No date-fns dep — that would be ~30 KB for 4 cases. */
  function formatRelative(ts: number): string {
    if (!ts) return '';
    const diffSec = Math.max(0, (Date.now() - ts) / 1000);
    if (diffSec < 60) return 'just now';
    const min = Math.floor(diffSec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day === 1) return 'yesterday';
    if (day < 7) return `${day}d ago`;
    const wk = Math.floor(day / 7);
    if (wk < 5) return `${wk}w ago`;
    const mo = Math.floor(day / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(day / 365)}y ago`;
  }

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

  <button type="button" class="list-item new-btn" onclick={startNew} disabled={chat.sending}>
    <span class="check" aria-hidden="true">+</span>
    <span class="item-text"><span class="item-label">New session</span></span>
  </button>

  <div class="divider"></div>

  {#if loading}
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
        >
          <span class="item-text">
            <span class="item-label">{s.title || 'Untitled'}{#if s.id === activeSessionId}<span class="sr-only"> (current)</span>{/if}</span>
            <span class="item-meta">{formatRelative(s.updatedAt)}</span>
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
</div>

<style>
  .session-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
  }

  .list-item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm, 6px);
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--color-text);
  }
  .list-item:hover:not(:disabled),
  .list-item:focus-visible {
    background: var(--color-bg-tertiary);
  }
  .list-item:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  /* Active row: an inset primary bar instead of a background tint, so the
     timestamp keeps full contrast against the panel/drawer surface. */
  .list-item.active {
    box-shadow: inset 3px 0 0 var(--color-primary);
  }
  .list-item.active .item-label {
    font-weight: 600;
  }

  /* Primary action — a filled, rounded, inset button (orange with dark text) so
     it reads as a pressable CTA distinct from the flat list rows below, matching
     the app's primary-fill convention. Orange is never used as text. */
  .new-btn {
    background: var(--color-primary);
    color: #000;
    font-weight: 600;
    border-radius: var(--radius-md);
    justify-content: center;
    margin: 0 var(--space-1) var(--space-3);
  }
  .new-btn:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }
  .new-btn:focus-visible {
    background: var(--color-primary);
    outline: 2px solid var(--color-text);
    outline-offset: 2px;
  }
  .new-btn .check,
  .new-btn .item-label {
    color: #000;
  }

  /* The "+" on the filled New session button. */
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
  .item-label {
    font-weight: 500;
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item-meta {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .divider {
    height: 1px;
    margin: var(--space-2) 0;
    background: var(--color-border);
  }

  .session-list {
    overflow-y: auto;
    min-height: 0;
  }

  .empty,
  .list-error {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .list-error {
    color: var(--color-danger);
  }
  .list-error span:first-child {
    flex: 1;
  }
  .retry-btn {
    padding: 2px 8px;
    font-size: var(--text-xs);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--color-danger);
    cursor: pointer;
  }
  .retry-btn:hover {
    background: var(--color-danger);
    color: var(--color-text-inverse);
  }

  .notice {
    margin: 0 0 var(--space-2);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    background: var(--color-bg-tertiary);
    border-radius: var(--radius-sm, 6px);
  }

  .show-all {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: 0;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-sm, 6px);
  }
  .show-all:hover {
    background: var(--color-bg-tertiary);
  }
  .show-all:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }
</style>
