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
  let showAll = $state(false);
  let query = $state('');
  let editingId = $state<string | null>(null);
  let deletingId = $state<string | null>(null);
  let actionsId = $state<string | null>(null);
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

  // Rename/delete/new failures set chat.error, which renders in the chat page's
  // error banner — but that banner is inert and z-index BELOW this drawer's
  // scrim while the drawer is open, so it's invisible to the user acting here.
  // Surface the failure inside the panel instead.
  let actionError = $state('');

  async function startNew(): Promise<void> {
    if (chat.sending) return;
    actionError = '';
    const id = await chat.startNewSession();
    if (!id) {
      actionError = chat.error;
      return;
    }
    await navigateToSession(id);
    onChosen?.();
  }

  function beginRename(id: string, title: string): void {
    deletingId = null;
    actionsId = null;
    editingId = id;
    draftTitle = title;
  }

  async function saveRename(event: SubmitEvent, id: string): Promise<void> {
    event.preventDefault();
    if (workingId) return;
    workingId = id;
    actionError = '';
    try {
      if (await chat.renameSession(id, draftTitle)) editingId = null;
      else actionError = chat.error;
    } finally {
      workingId = null;
    }
  }

  async function confirmDelete(id: string): Promise<void> {
    if (workingId) return;
    const wasActive = id === chat.activeSessionId;
    workingId = id;
    actionError = '';
    try {
      if (!(await chat.deleteSession(id))) {
        actionError = chat.error;
        return;
      }
      deletingId = null;
      if (wasActive) await navigateToSession(chat.activeSessionId);
    } finally {
      workingId = null;
    }
  }

  async function retry(): Promise<void> {
    await chat.loadSessions();
  }

  function handleBodyClick(event: MouseEvent): void {
    const target = event.target;
    if (
      actionsId &&
      (!(target instanceof Element) || !target.closest('.session-actions'))
    ) {
      actionsId = null;
    }
  }

  function handleBodyKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !actionsId) return;
    event.preventDefault();
    event.stopPropagation();
    actionsId = null;
  }
</script>

<svelte:window onclick={handleBodyClick} onkeydowncapture={handleBodyKeydown} />

<div class="session-body">
  <div class="panel-intro">
    <p>Resume recent work or start with a clean conversation on {active?.label ?? 'this assistant'}.</p>
  </div>

  {#if !hideNewBtn}
    <button type="button" class="new-btn" onclick={startNew} disabled={chat.sending}>
      <span aria-hidden="true">+</span>
      <span>New conversation</span>
    </button>
  {/if}

  {#if chat.sending}
    <div class="notice">Wait for the current reply to finish before switching conversations.</div>
  {/if}

  {#if actionError}
    <div class="notice notice-error" role="alert">{actionError}</div>
  {/if}

  {#if !endpointState || loading}
    <div class="state-card" role="status"><Spinner size={16} /><span>Loading conversations…</span></div>
  {:else if error}
    <div class="state-card error" role="alert">
      <strong>Conversations could not be loaded.</strong>
      <span>{error}</span>
      <button type="button" class="secondary-btn" onclick={retry}>Retry</button>
    </div>
  {:else if sessions.length === 0}
    <div class="state-card">
      <strong>No conversations yet</strong>
      <span>Start a conversation and it will appear here.</span>
    </div>
  {:else}
    <label class="session-search sticky">
      <span>Search conversations</span>
      <input type="search" placeholder="Type a title" bind:value={query} />
    </label>

    {#if filteredSessions.length === 0}
      <div class="state-card">
        <strong>No matching conversations</strong>
        <span>Try another title or clear the search.</span>
      </div>
    {:else}
      <div class="session-list" role="group" aria-label="Conversations">
        {#each visibleSessions as s (s.id)}
          {@const displayTitle = resolveSessionTitle(s.title)}
          {@const current = s.id === activeSessionId}
          <div class="session-row" class:active={current}>
            <button
              type="button"
              class="session-item"
              aria-label={`Resume conversation: ${displayTitle}, ${formatRelativeTime(s.updatedAt)}`}
              aria-current={current ? 'true' : undefined}
              onclick={() => pick(s.id)}
              disabled={chat.sending || workingId !== null}
              title={formatDateTime(s.updatedAt)}
            >
              <span class="item-text">
                <span class="item-label"><SessionTitle title={s.title} /></span>
                <span class="item-meta">
                  {#if current}<span class="current-badge">Current</span>{/if}
                  <span>{formatRelativeTime(s.updatedAt)}</span>
                </span>
              </span>
            </button>
            <div class="session-actions">
              <button
                type="button"
                class="action-trigger"
                aria-label={`More actions for ${displayTitle}`}
                aria-expanded={actionsId === s.id}
                title="More actions"
                onclick={() => (actionsId = actionsId === s.id ? null : s.id)}
              >•••</button>
              {#if actionsId === s.id}
                <div class="action-menu">
                  <button
                    type="button"
                    disabled={chat.sending || workingId !== null}
                    onclick={() => beginRename(s.id, s.title)}
                  >Rename</button>
                  <button
                    type="button"
                    class="danger"
                    disabled={chat.sending || workingId !== null}
                    onclick={() => {
                      actionsId = null;
                      editingId = null;
                      deletingId = s.id;
                    }}
                  >Delete conversation</button>
                </div>
              {/if}
            </div>

            {#if editingId === s.id}
              <form class="inline-action" onsubmit={(event) => saveRename(event, s.id)}>
                <label>
                  <span>Conversation name</span>
                  <input maxlength="120" bind:value={draftTitle} />
                </label>
                <div class="inline-buttons">
                  <button type="button" class="secondary-btn" onclick={() => (editingId = null)}>Cancel</button>
                  <button type="submit" class="primary-btn" disabled={!draftTitle.trim() || workingId !== null}>Save name</button>
                </div>
              </form>
            {/if}

            {#if deletingId === s.id}
              <div class="inline-action confirmation" role="alertdialog" aria-label={`Delete ${displayTitle}?`}>
                <strong>Delete “{displayTitle}”?</strong>
                <span>This removes the conversation from {active?.label ?? 'this assistant'}. This cannot be undone.</span>
                <div class="inline-buttons">
                  <button type="button" class="secondary-btn" onclick={() => (deletingId = null)}>Cancel</button>
                  <button type="button" class="danger-btn" disabled={workingId !== null} onclick={() => confirmDelete(s.id)}>Delete conversation</button>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
      {#if !showAll && overflowCount > 0}
        <button type="button" class="show-all" onclick={() => (showAll = true)}>
          Show {overflowCount} more conversations
        </button>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .session-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-4);
    min-height: 0;
  }
  .panel-intro p {
    margin: 0;
    color: var(--s-ink-2);
    font-size: 0.875rem;
    line-height: 1.55;
  }
  .new-btn,
  .secondary-btn,
  .primary-btn,
  .danger-btn,
  .show-all {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-sp-2);
    min-width: 44px;
    min-height: 44px;
    padding: 0 var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 8px;
    background: transparent;
    color: var(--s-ink);
    font-family: var(--s-font-display);
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
  }
  .new-btn {
    width: 100%;
    background: var(--s-ink);
    border-color: var(--s-ink);
    color: var(--s-paper);
  }
  .new-btn span:first-child {
    font-size: 1.25rem;
    font-weight: 400;
  }
  .new-btn:hover:not(:disabled) {
    opacity: 0.86;
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  button:focus-visible,
  .action-trigger:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 2px;
  }
  .notice {
    padding: var(--s-sp-3);
    border-radius: 8px;
    background: var(--s-paper-deep);
    color: var(--s-ink-2);
    font-size: 0.875rem;
  }
  .notice-error {
    background: color-mix(in srgb, var(--s-seal) 8%, transparent);
    color: var(--s-seal);
    border: 1px solid color-mix(in srgb, var(--s-seal) 25%, transparent);
  }
  .session-search {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
    color: var(--s-ink-2);
    font-size: 0.875rem;
    font-weight: 600;
  }
  .session-search.sticky {
    position: sticky;
    top: calc(-1 * var(--s-sp-5));
    z-index: 2;
    padding-block: var(--s-sp-2);
    background: var(--s-paper);
  }
  .session-search input,
  .inline-action input {
    width: 100%;
    min-height: 44px;
    padding: 0 var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 8px;
    background: var(--s-paper);
    color: var(--s-ink);
    font: inherit;
    font-size: 0.875rem;
  }
  .session-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
    min-height: 0;
  }
  .session-row {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 44px;
    align-items: center;
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 10px;
    background: color-mix(in srgb, var(--s-paper-deep) 48%, transparent);
  }
  .session-row.active {
    border-color: var(--s-seal);
    box-shadow: inset 3px 0 0 var(--s-seal);
    background: var(--s-paper-deep);
  }
  .session-item {
    display: flex;
    align-items: center;
    min-width: 0;
    min-height: 64px;
    padding: var(--s-sp-2) var(--s-sp-3);
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--s-ink);
    text-align: left;
    cursor: pointer;
  }
  .session-item:hover:not(:disabled) {
    background: color-mix(in srgb, var(--s-ink) 5%, transparent);
  }
  .item-text {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: var(--s-sp-1);
  }
  .item-label {
    overflow: hidden;
    color: var(--s-ink);
    font-family: var(--s-font-display);
    font-size: 0.9375rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item-meta {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: 0.75rem;
  }
  .current-badge {
    padding: 1px var(--s-sp-2);
    border-radius: 99px;
    background: color-mix(in srgb, var(--s-seal) 14%, transparent);
    color: var(--s-seal);
    font-weight: 700;
  }
  .session-actions {
    position: relative;
    align-self: stretch;
  }
  .action-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    min-height: 44px;
    border: 0;
    background: transparent;
    border-radius: 8px;
    color: var(--s-ink-2);
    cursor: pointer;
    letter-spacing: 2px;
  }
  .action-trigger:hover {
    background: color-mix(in srgb, var(--s-ink) 6%, transparent);
    color: var(--s-ink);
  }
  .action-menu {
    position: absolute;
    top: calc(100% - 6px);
    right: 6px;
    z-index: 3;
    display: flex;
    width: 184px;
    flex-direction: column;
    padding: var(--s-sp-1);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 8px;
    background: var(--s-paper);
    box-shadow: 0 8px 24px color-mix(in srgb, var(--s-ink) 18%, transparent);
  }
  .action-menu button {
    min-height: 44px;
    padding: 0 var(--s-sp-3);
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--s-ink);
    text-align: left;
    cursor: pointer;
  }
  .action-menu button:hover {
    background: var(--s-paper-deep);
  }
  .action-menu .danger,
  .danger-btn {
    color: var(--s-error);
  }
  .inline-action {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
    padding: var(--s-sp-3);
    border-top: var(--s-hair) solid var(--s-line-soft);
    color: var(--s-ink-2);
    font-size: 0.875rem;
  }
  .inline-action label {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
    font-weight: 600;
  }
  .inline-buttons {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-sp-2);
  }
  .primary-btn {
    background: transparent;
    border-color: var(--s-line);
    color: var(--s-ink);
  }
  .danger-btn {
    border-color: var(--s-error);
  }
  .confirmation strong {
    color: var(--s-ink);
    font-size: 1rem;
  }
  .state-card {
    display: flex;
    align-items: flex-start;
    gap: var(--s-sp-2);
    flex-direction: column;
    padding: var(--s-sp-5);
    border: var(--s-hair) dashed var(--s-line-soft);
    border-radius: 10px;
    color: var(--s-ink-2);
    font-size: 0.875rem;
  }
  .state-card strong {
    color: var(--s-ink);
    font-size: 1rem;
  }
  .state-card.error {
    border-color: var(--s-error);
  }
  .state-card.error strong {
    color: var(--s-error);
  }
  .show-all {
    width: 100%;
  }
  .show-all:hover,
  .secondary-btn:hover,
  .danger-btn:hover {
    background: var(--s-paper-deep);
  }

  @media (max-width: 420px) {
    .inline-buttons {
      flex-direction: column-reverse;
    }
    .inline-buttons button {
      width: 100%;
    }
  }
</style>
