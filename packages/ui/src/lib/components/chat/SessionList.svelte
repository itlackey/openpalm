<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import Spinner from '@openpalm/ui-kit/components/common/Spinner.svelte';
  import SessionTitle from '$lib/components/chat/SessionTitle.svelte';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { buildConversationPath } from '$lib/chat/navigation.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { formatRelativeTime, formatDateTime } from '$lib/format-date.js';
  import { resolveSessionTitle } from '$lib/session-title.js';

  interface Props {
    /** Called after a conversation is opened or started (e.g. to close the drawer). */
    onChosen?: () => void;
    /** Hide the internal new-conversation button when the parent already provides one. */
    hideNewBtn?: boolean;
  }
  let { onChosen, hideNewBtn = false }: Props = $props();

  const SESSION_LIST_CAP = 50;
  const SEARCH_THRESHOLD = 8;
  let showAll = $state(false);
  let query = $state('');
  let editingId = $state<string | null>(null);
  let deletingId = $state<string | null>(null);
  let draftTitle = $state('');
  let workingId = $state<string | null>(null);

  const active = $derived(endpointsService.active);
  const endpointState = $derived(active ? (chat.byEndpoint.get(active.id) ?? null) : null);
  const sessions = $derived(endpointState?.sessions ?? []);
  const loading = $derived(endpointState?.sessionsLoading ?? false);
  const error = $derived(endpointState?.sessionsError ?? '');
  const activeSessionId = $derived(chat.activeSessionId);
  const filteredSessions = $derived.by(() => {
    const search = query.trim().toLocaleLowerCase();
    if (!search) return sessions;
    return sessions.filter((session) =>
      resolveSessionTitle(session.title).toLocaleLowerCase().includes(search)
    );
  });
  const visibleSessions = $derived(
    showAll ? filteredSessions : filteredSessions.slice(0, SESSION_LIST_CAP)
  );
  const overflowCount = $derived(Math.max(0, filteredSessions.length - SESSION_LIST_CAP));

  onMount(() => {
    if (active && !endpointState?.sessionsLoaded && !loading) {
      void chat.loadSessions();
    }
  });

  async function navigateToSession(sessionId: string | null): Promise<void> {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- dynamic mode-preserving path built internally
    await goto(buildConversationPath(page.url.pathname, sessionId, active?.id));
  }

  async function pick(id: string): Promise<void> {
    if (chat.sending) return;
    await chat.openSession(id);
    await navigateToSession(id);
    onChosen?.();
  }

  async function startNew(): Promise<void> {
    if (chat.sending) return;
    const id = await chat.startNewSession();
    if (!id) return;
    await navigateToSession(id);
    onChosen?.();
  }

  function beginRename(id: string, title: string): void {
    deletingId = null;
    editingId = id;
    draftTitle = title;
  }

  async function saveRename(event: SubmitEvent, id: string): Promise<void> {
    event.preventDefault();
    if (workingId) return;
    workingId = id;
    try {
      if (await chat.renameSession(id, draftTitle)) editingId = null;
    } finally {
      workingId = null;
    }
  }

  async function confirmDelete(id: string): Promise<void> {
    if (workingId) return;
    const wasActive = id === chat.activeSessionId;
    workingId = id;
    try {
      if (!(await chat.deleteSession(id))) return;
      deletingId = null;
      if (wasActive) await navigateToSession(chat.activeSessionId);
    } finally {
      workingId = null;
    }
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
    <div class="empty"><Spinner size={12} /><span>Loading conversations…</span></div>
  {:else if error}
    <div class="list-error">
      <span>{error}</span>
      <button type="button" class="retry-btn" onclick={retry}>Retry</button>
    </div>
  {:else if sessions.length === 0}
    <div class="empty">No conversations yet. Start the first one.</div>
  {:else}
    {#if sessions.length >= SEARCH_THRESHOLD}
      <label class="session-search sticky">
        <span class="sr-only">Search conversations</span>
        <input
          type="search"
          aria-label="Search conversations"
          placeholder="Search conversations"
          bind:value={query}
        />
      </label>
    {/if}

    {#if filteredSessions.length === 0}
      <div class="empty">No conversations match your search.</div>
    {:else}
      <div class="session-list" role="group" aria-label="Conversations">
        {#each visibleSessions as s (s.id)}
          {@const displayTitle = resolveSessionTitle(s.title)}
          <div class="session-row" class:active={s.id === activeSessionId}>
            <button
              type="button"
              class="list-item session-item"
              aria-label={displayTitle}
              aria-current={s.id === activeSessionId ? 'true' : undefined}
              onclick={() => pick(s.id)}
              disabled={chat.sending || workingId !== null}
              title={formatDateTime(s.updatedAt)}
            >
              <span class="item-text">
                <span class="item-label"><SessionTitle title={s.title} />{#if s.id === activeSessionId}<span class="sr-only"> (current)</span>{/if}</span>
                <span class="item-meta">{formatRelativeTime(s.updatedAt)}</span>
              </span>
            </button>
            <div class="session-actions">
              <button
                type="button"
                class="action-btn"
                aria-label="Rename {displayTitle}"
                title="Rename"
                disabled={chat.sending || workingId !== null}
                onclick={() => beginRename(s.id, s.title)}
              >Rename</button>
              <button
                type="button"
                class="action-btn danger"
                aria-label="Delete {displayTitle}"
                title="Delete"
                disabled={chat.sending || workingId !== null}
                onclick={() => {
                  editingId = null;
                  deletingId = s.id;
                }}
              >Delete</button>
            </div>

            {#if editingId === s.id}
              <form class="inline-action" onsubmit={(event) => saveRename(event, s.id)}>
                <label>
                  <span class="sr-only">Conversation name</span>
                  <input aria-label="Conversation name" maxlength="120" bind:value={draftTitle} />
                </label>
                <button type="submit" class="action-btn primary" disabled={!draftTitle.trim() || workingId !== null}>Save name</button>
                <button type="button" class="action-btn" onclick={() => (editingId = null)}>Cancel</button>
              </form>
            {/if}

            {#if deletingId === s.id}
              <div class="inline-action confirmation" role="alertdialog" aria-label="Delete {displayTitle}?">
                <span>Delete &quot;{displayTitle}&quot;? This cannot be undone.</span>
                <button type="button" class="action-btn" onclick={() => (deletingId = null)}>Cancel</button>
                <button type="button" class="action-btn danger" disabled={workingId !== null} onclick={() => confirmDelete(s.id)}>Delete conversation</button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
      {#if !showAll && overflowCount > 0}
        <button type="button" class="show-all" onclick={() => (showAll = true)}>
          Show all ({overflowCount} more)
        </button>
      {/if}
    {/if}
  {/if}

  {#if !hideNewBtn}
    <div class="divider"></div>
    <button type="button" class="list-item new-btn" onclick={startNew} disabled={chat.sending}>
      <span class="check" aria-hidden="true">+</span>
      <span class="item-text"><span class="item-label">New conversation</span></span>
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

  .session-search {
    display: block;
    padding: var(--s-sp-2);
    background: var(--s-paper);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }
  .session-search.sticky {
    position: sticky;
    top: 0;
    z-index: 2;
  }
  .session-search input,
  .inline-action input {
    width: 100%;
    min-height: 36px;
    padding: var(--s-sp-2) var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper);
    color: var(--s-ink-2);
    font: inherit;
  }
  .session-search input {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
  }

  .session-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    width: 100%;
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }
  .session-row.active {
    border-left: 2px solid var(--s-seal);
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
  .session-item {
    width: 100%;
    min-width: 0;
    min-height: 44px;
    border-bottom: 0;
  }
  .session-row.active .session-item {
    padding-left: calc(var(--s-sp-3) - 2px);
  }
  .list-item:hover:not(:disabled),
  .list-item:focus-visible {
    color: var(--s-ink-2);
  }
  .list-item:focus-visible,
  .action-btn:focus-visible,
  .session-search input:focus-visible,
  .inline-action input:focus-visible {
    outline: var(--s-hair) solid var(--s-line);
    outline-offset: -1px;
  }
  .list-item:disabled,
  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .session-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-right: var(--s-sp-2);
  }
  .action-btn {
    min-height: 32px;
    padding: 2px 7px;
    border: var(--s-hair) solid transparent;
    background: none;
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    cursor: pointer;
  }
  .action-btn:hover:not(:disabled) {
    color: var(--s-ink-2);
    border-color: var(--s-line-soft);
  }
  .action-btn.primary,
  .action-btn.danger {
    color: var(--s-seal);
  }

  .inline-action {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    width: 100%;
    padding: var(--s-sp-2) var(--s-sp-3);
    border-top: var(--s-hair) solid var(--s-line-soft);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-3);
  }
  .inline-action label {
    flex: 1;
  }
  .confirmation span {
    flex: 1;
  }

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
  .item-label {
    font-family: var(--s-font-display);
    font-size: clamp(0.9rem, 2.2vw, 1.05rem);
    font-weight: 400;
    color: var(--s-ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
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
    min-height: 44px;
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

  @media (max-width: 520px) {
    .session-actions {
      grid-column: 1 / -1;
      width: 100%;
      justify-content: flex-end;
      padding: 0 var(--s-sp-2) var(--s-sp-2);
    }
    .inline-action {
      align-items: stretch;
      flex-wrap: wrap;
    }
    .inline-action label,
    .confirmation span {
      flex-basis: 100%;
    }
  }
</style>
