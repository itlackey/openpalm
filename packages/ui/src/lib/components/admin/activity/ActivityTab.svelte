<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { getSessionMessages, listSessions } from '$lib/api.js';
  import type { ChatEntry, SessionSummary } from '$lib/types.js';
  import {
    subscribeSessionEvents,
    type OpenCodeSessionEventPayload,
  } from '$lib/chat/session-events.js';

  type StreamState = 'connecting' | 'connected' | 'disconnected';
  type AttentionSeverity = 'high' | 'medium' | 'low';

  type AttentionItem = {
    id: string;
    severity: AttentionSeverity;
    title: string;
    detail: string;
    sessionId: string;
    timestamp: number;
  };

  let loading = $state(false);
  let messagesLoading = $state(false);
  let error = $state('');
  let streamError = $state('');
  let streamState = $state<StreamState>('connecting');
  let sessions = $state<SessionSummary[]>([]);
  let selectedSessionId = $state<string | null>(null);
  let selectedMessages = $state<ChatEntry[]>([]);
  let attentionFeed = $state<AttentionItem[]>([]);
  let clock = $state(Date.now());

  let unsubscribe: (() => void) | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let clockTimer: ReturnType<typeof setInterval> | null = null;

  function eventSessionId(payload: OpenCodeSessionEventPayload): string {
    const props = payload.properties as Record<string, unknown> | undefined;
    if (typeof props?.sessionID === 'string') return props.sessionID;
    const info = props?.info as { id?: unknown } | undefined;
    return typeof info?.id === 'string' ? info.id : '';
  }

  function truncate(text: string, max = 140): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function summarizeEvent(payload: OpenCodeSessionEventPayload): Omit<AttentionItem, 'id' | 'timestamp'> | null {
    const props = payload.properties as Record<string, unknown> | undefined;
    const sessionId = eventSessionId(payload);
    const type = payload.type;

    if (type === 'permission.asked') {
      return {
        severity: 'high',
        title: 'Approval needed',
        detail: typeof props?.permission === 'string' ? props.permission : 'Assistant is waiting for a permission decision.',
        sessionId,
      };
    }

    if (type === 'question.asked') {
      return {
        severity: 'high',
        title: 'Answer requested',
        detail: Array.isArray(props?.questions)
          ? `${props.questions.length} question${props.questions.length === 1 ? '' : 's'} waiting for an answer.`
          : 'Assistant asked a question.',
        sessionId,
      };
    }

    if (type === 'session.error') {
      return {
        severity: 'high',
        title: 'Session error',
        detail: typeof props?.error === 'string' ? props.error : 'Assistant session reported an error.',
        sessionId,
      };
    }

    if (type === 'session.deleted') {
      return {
        severity: 'medium',
        title: 'Session removed',
        detail: 'An active session was deleted.',
        sessionId,
      };
    }

    if (type === 'session.created') {
      return {
        severity: 'low',
        title: 'New session started',
        detail: 'A new conversation became active.',
        sessionId,
      };
    }

    if (type.startsWith('session.next.tool.')) {
      const toolName = typeof props?.tool === 'string' ? props.tool : 'tool';
      const progress = typeof props?.progress === 'string'
        ? props.progress
        : typeof props?.message === 'string'
          ? props.message
          : '';
      if (type.endsWith('.failed')) {
        return {
          severity: 'high',
          title: `Tool failed: ${toolName}`,
          detail: truncate(progress || 'Assistant tool execution failed.'),
          sessionId,
        };
      }
      if (type.endsWith('.called')) {
        return {
          severity: 'medium',
          title: `Tool running: ${toolName}`,
          detail: truncate(progress || 'Assistant started a tool.'),
          sessionId,
        };
      }
      if (type.endsWith('.completed')) {
        return {
          severity: 'low',
          title: `Tool finished: ${toolName}`,
          detail: 'Assistant completed a tool call.',
          sessionId,
        };
      }
    }

    if (type === 'message.part.updated') {
      const part = props?.part as { tool?: unknown; state?: { status?: unknown; error?: unknown } } | undefined;
      if (typeof part?.tool === 'string' && part.state?.status === 'error') {
        return {
          severity: 'high',
          title: `Tool failed: ${part.tool}`,
          detail: typeof part.state.error === 'string' ? truncate(part.state.error) : 'Assistant tool execution failed.',
          sessionId,
        };
      }
    }

    return null;
  }

  function pushAttention(payload: OpenCodeSessionEventPayload): void {
    const summary = summarizeEvent(payload);
    if (!summary) return;
    const timestamp = Date.now();
    attentionFeed = [
      {
        id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp,
        ...summary,
      },
      ...attentionFeed,
    ].slice(0, 30);
  }

  function upsertSession(summary: SessionSummary): void {
    const existing = sessions.find((session) => session.id === summary.id);
    if (existing) {
      sessions = [
        { ...existing, ...summary },
        ...sessions.filter((session) => session.id !== summary.id),
      ].sort((left, right) => right.updatedAt - left.updatedAt);
      return;
    }
    sessions = [summary, ...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  function handleSessionPayload(payload: OpenCodeSessionEventPayload): void {
    const props = payload.properties as Record<string, unknown> | undefined;
    const info = props?.info as { id?: unknown; title?: unknown; time?: { created?: unknown; updated?: unknown } } | undefined;
    const sessionId = eventSessionId(payload);
    if (payload.type === 'session.deleted' && sessionId) {
      sessions = sessions.filter((session) => session.id !== sessionId);
      if (selectedSessionId === sessionId) {
        selectedSessionId = sessions[0]?.id ?? null;
      }
      return;
    }
    if (!sessionId) return;
    const existing = sessions.find((session) => session.id === sessionId);
    const createdAt = typeof info?.time?.created === 'number' ? info.time.created : (existing?.createdAt ?? Date.now());
    const updatedAt = typeof info?.time?.updated === 'number' ? info.time.updated : Date.now();
    upsertSession({
      id: sessionId,
      title: typeof info?.title === 'string' ? info.title : (existing?.title ?? ''),
      createdAt,
      updatedAt,
    });
  }

  async function loadSessions(): Promise<void> {
    loading = true;
    error = '';
    try {
      sessions = await listSessions();
      if (!selectedSessionId || !sessions.some((session) => session.id === selectedSessionId)) {
        selectedSessionId = sessions[0]?.id ?? null;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load sessions.';
    } finally {
      loading = false;
    }
  }

  async function loadMessages(sessionId: string | null): Promise<void> {
    if (!sessionId) {
      selectedMessages = [];
      return;
    }
    messagesLoading = true;
    try {
      selectedMessages = await getSessionMessages(sessionId);
    } catch {
      selectedMessages = [];
    } finally {
      messagesLoading = false;
    }
  }

  async function selectSession(sessionId: string): Promise<void> {
    selectedSessionId = sessionId;
    await loadMessages(sessionId);
  }

  function fmtTime(timestamp: number | null): string {
    if (!timestamp) return 'n/a';
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDateTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  let selectedSession = $derived(sessions.find((session) => session.id === selectedSessionId) ?? null);
  let waitingItems = $derived(attentionFeed.filter((item) => item.title === 'Approval needed' || item.title === 'Answer requested').length);
  let failingItems = $derived(attentionFeed.filter((item) => item.severity === 'high').length);
  let activeSessions = $derived(sessions.filter((session) => clock - session.updatedAt <= 5 * 60_000).length);
  let latestAttention = $derived(attentionFeed.slice(0, 10));

  onMount(() => {
    void endpointsService.load();
    void loadSessions().then(() => loadMessages(selectedSessionId));
    streamState = 'connecting';
    unsubscribe = subscribeSessionEvents({
      onConnect: () => {
        streamState = 'connected';
        streamError = '';
      },
      onDisconnect: (err) => {
        streamState = 'disconnected';
        streamError = err.message;
      },
      onCreated: () => {},
      onUpdated: () => {},
      onDeleted: () => {},
      onEvent: (payload) => {
        streamState = 'connected';
        pushAttention(payload);
        handleSessionPayload(payload);
      },
    });
    reconcileTimer = setInterval(() => { void loadSessions(); }, 30_000);
    clockTimer = setInterval(() => { clock = Date.now(); }, 5_000);
  });

  onDestroy(() => {
    unsubscribe?.();
    if (reconcileTimer) clearInterval(reconcileTimer);
    if (clockTimer) clearInterval(clockTimer);
  });
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Activity</h2>
      <p class="panel-subtitle">A readable view of what the assistant is doing right now, which sessions need attention, and the recent history for a selected conversation.</p>
    </div>
    <div class="panel-header-actions">
      <button class="btn btn-secondary btn-sm" onclick={() => void loadSessions()} disabled={loading}>
        {#if loading}<Spinner />{/if}
        Refresh
      </button>
    </div>
  </div>

  {#if error}<div class="error-banner"><span>{error}</span></div>{/if}
  {#if streamError && streamState === 'disconnected'}
    <div class="error-banner"><span>{streamError}</span></div>
  {/if}

  <div class="summary-grid">
    <div class="summary-card">
      <span class="summary-label">Stream</span>
      <strong class="summary-value">{streamState}</strong>
      <small>{streamState === 'connected' ? 'Live events are flowing.' : streamState === 'connecting' ? 'Connecting to the assistant event stream.' : 'Reconnect needed.'}</small>
    </div>
    <div class="summary-card">
      <span class="summary-label">Sessions</span>
      <strong class="summary-value">{sessions.length}</strong>
      <small>{activeSessions} active in the last 5 minutes</small>
    </div>
    <div class="summary-card summary-card--warning">
      <span class="summary-label">Waiting on people</span>
      <strong class="summary-value">{waitingItems}</strong>
      <small>Permissions and answers that block the assistant.</small>
    </div>
    <div class="summary-card" class:summary-card--danger={failingItems > 0}>
      <span class="summary-label">Attention items</span>
      <strong class="summary-value">{failingItems}</strong>
      <small>{failingItems > 0 ? 'Tool or session failures need review.' : 'No current failures seen.'}</small>
    </div>
  </div>

  <div class="activity-layout">
    <section class="card-section">
      <div class="card-head">
        <h3>Needs attention</h3>
        <span>{latestAttention.length}</span>
      </div>
      <div class="attention-list">
        {#if latestAttention.length === 0}
          <div class="empty-card">Nothing urgent has happened yet.</div>
        {/if}
        {#each latestAttention as item (item.id)}
          <article class="attention-item attention-item--{item.severity}">
            <div class="attention-top">
              <strong>{item.title}</strong>
              <span>{fmtTime(item.timestamp)}</span>
            </div>
            <p>{item.detail}</p>
            {#if item.sessionId}
              <button class="attention-session mono" type="button" onclick={() => void selectSession(item.sessionId)}>
                {item.sessionId}
              </button>
            {/if}
          </article>
        {/each}
      </div>
    </section>

    <section class="card-section">
      <div class="card-head">
        <h3>Recent sessions</h3>
        <span>{sessions.length}</span>
      </div>
      <div class="session-list">
        {#if sessions.length === 0 && !loading}
          <div class="empty-card">No sessions found on the active assistant endpoint.</div>
        {/if}
        {#each sessions.slice(0, 12) as session (session.id)}
          <button class:selected={selectedSessionId === session.id} class="session-row" onclick={() => void selectSession(session.id)}>
            <div>
              <div class="session-title">{session.title || 'Untitled session'}</div>
              <div class="session-meta">Updated {fmtDateTime(session.updatedAt)}</div>
            </div>
            <div class="session-id mono">{session.id.slice(0, 12)}…</div>
          </button>
        {/each}
      </div>
    </section>
  </div>

  <section class="card-section session-details">
    <div class="card-head">
      <h3>Selected session</h3>
      {#if selectedSession}<span>{selectedSession.title || selectedSession.id}</span>{/if}
    </div>

    {#if selectedSession}
      <div class="selected-meta">
        <div><span>Created</span><strong>{fmtDateTime(selectedSession.createdAt)}</strong></div>
        <div><span>Updated</span><strong>{fmtDateTime(selectedSession.updatedAt)}</strong></div>
        <div><span>Session ID</span><strong class="mono">{selectedSession.id}</strong></div>
      </div>

      <div class="message-panel-head">
        <span>Recent activity</span>
        <button class="btn btn-ghost btn-sm" onclick={() => void loadMessages(selectedSession.id)} disabled={messagesLoading}>
          {#if messagesLoading}<Spinner />{/if}
          Refresh
        </button>
      </div>

      {#if selectedMessages.length === 0 && !messagesLoading}
        <div class="empty-card">No chat or tool activity available for this session yet.</div>
      {/if}

      <div class="selected-message-list">
        {#each selectedMessages.slice(-12) as entry (entry.id)}
          <ChatMessage {entry} />
        {/each}
      </div>
    {:else}
      <div class="empty-card">Select a session to inspect its recent chat and tool activity.</div>
    {/if}
  </section>
</div>

<style>
  .panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); flex-wrap: wrap; }
  .panel-subtitle { margin: var(--space-1) 0 0; font-size: var(--text-sm); color: var(--color-text-secondary); max-width: 75ch; }
  .panel-header-actions { display: flex; gap: var(--space-2); }
  .error-banner { background: var(--color-danger-subtle, rgba(239,68,68,0.1)); color: var(--color-danger, #ef4444); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); margin-bottom: var(--space-4); }
  .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); margin-bottom: var(--space-4); }
  .summary-card { display: grid; gap: var(--space-1); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-secondary); }
  .summary-card--warning { background: color-mix(in srgb, var(--color-bg-secondary) 92%, #f59e0b 8%); }
  .summary-card--danger { background: color-mix(in srgb, var(--color-bg-secondary) 90%, #ef4444 10%); }
  .summary-label { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-secondary); }
  .summary-value { font-size: clamp(1.2rem, 3vw, 1.9rem); color: var(--color-text); }
  .summary-card small { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .activity-layout { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: var(--space-4); margin-bottom: var(--space-4); }
  .card-section { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-secondary); padding: var(--space-4); min-width: 0; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-3); }
  .card-head h3 { margin: 0; font-size: var(--text-base); color: var(--color-text); }
  .card-head span { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .attention-list, .session-list, .selected-message-list { display: flex; flex-direction: column; gap: var(--space-2); }
  .attention-item { padding: var(--space-3); border-radius: var(--radius-sm); border: 1px solid var(--color-border); background: var(--color-bg); }
  .attention-item--high { border-color: color-mix(in srgb, var(--color-danger) 45%, var(--color-border)); }
  .attention-item--medium { border-color: color-mix(in srgb, #f59e0b 45%, var(--color-border)); }
  .attention-top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-1); }
  .attention-top strong { font-size: var(--text-sm); color: var(--color-text); }
  .attention-top span { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .attention-item p { margin: 0; font-size: var(--text-sm); color: var(--color-text-secondary); }
  .attention-session { margin-top: var(--space-2); border: 0; background: transparent; color: var(--color-primary); padding: 0; cursor: pointer; text-align: left; }
  .session-row { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); text-align: left; padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); color: var(--color-text); cursor: pointer; }
  .session-row.selected { border-color: var(--color-primary); box-shadow: inset 0 0 0 1px var(--color-primary); }
  .session-title { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); }
  .session-meta { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .session-id { font-size: var(--text-xs); color: var(--color-text-tertiary); }
  .selected-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); margin-bottom: var(--space-4); }
  .selected-meta div { display: grid; gap: var(--space-1); padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); }
  .selected-meta span { font-size: var(--text-xs); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
  .selected-meta strong { font-size: var(--text-sm); color: var(--color-text); }
  .message-panel-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-3); }
  .empty-card { font-size: var(--text-sm); color: var(--color-text-secondary); text-align: center; padding: var(--space-4); border: 1px dashed var(--color-border); border-radius: var(--radius-sm); }
  .mono { font-family: var(--font-mono); }
  @media (max-width: 1100px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .activity-layout { grid-template-columns: 1fr; } .selected-meta { grid-template-columns: 1fr; } }
  @media (max-width: 640px) { .summary-grid { grid-template-columns: 1fr; } }
</style>
