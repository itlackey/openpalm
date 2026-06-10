<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { getSessionMessages, listSessions } from '$lib/api.js';
  import type { ChatEntry, SessionSummary } from '$lib/types.js';
  import {
    subscribeSessionEvents,
    type OpenCodeSessionEventPayload,
  } from '$lib/chat/session-events.js';

  type StreamState = 'connecting' | 'connected' | 'disconnected';

  type FeedItem = {
    id: string;
    type: string;
    sessionId: string;
    title: string;
    detail: string;
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
  let eventFeed = $state<FeedItem[]>([]);
  let eventCounts = $state<Record<string, number>>({});
  let sessionEventCounts = $state<Record<string, number>>({});
  let minuteTimestamps = $state<number[]>([]);
  let lastEventAt = $state<number | null>(null);
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

  function eventTitle(payload: OpenCodeSessionEventPayload): string {
    const props = payload.properties as Record<string, unknown> | undefined;
    const info = props?.info as { title?: unknown } | undefined;
    if (typeof info?.title === 'string' && info.title.trim()) return info.title;
    const sessionId = eventSessionId(payload);
    return sessionId ? `Session ${sessionId.slice(0, 8)}` : 'Global event';
  }

  function eventDetail(payload: OpenCodeSessionEventPayload): string {
    const props = payload.properties as Record<string, unknown> | undefined;
    if (!props) return '';
    if (payload.type === 'permission.asked') return typeof props.permission === 'string' ? props.permission : 'Permission requested';
    if (payload.type === 'question.asked') return Array.isArray(props.questions) ? `${props.questions.length} question(s)` : 'Question requested';
    if (payload.type.startsWith('session.next.tool.')) return typeof props.tool === 'string' ? props.tool : 'Tool activity';
    if (payload.type === 'message.part.updated') {
      const part = props.part as { type?: unknown; tool?: unknown } | undefined;
      if (typeof part?.tool === 'string') return part.tool;
      if (typeof part?.type === 'string') return part.type;
    }
    if (payload.type === 'session.updated') return typeof (props.info as { title?: unknown } | undefined)?.title === 'string' ? 'Session metadata changed' : 'Session updated';
    return '';
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

  function pushEvent(payload: OpenCodeSessionEventPayload): void {
    const timestamp = Date.now();
    const type = payload.type || 'unknown';
    const sessionId = eventSessionId(payload);
    const item: FeedItem = {
      id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      sessionId,
      title: eventTitle(payload),
      detail: eventDetail(payload),
      timestamp,
    };
    eventFeed = [item, ...eventFeed].slice(0, 120);
    eventCounts = { ...eventCounts, [type]: (eventCounts[type] ?? 0) + 1 };
    if (sessionId) {
      sessionEventCounts = { ...sessionEventCounts, [sessionId]: (sessionEventCounts[sessionId] ?? 0) + 1 };
    }
    minuteTimestamps = [timestamp, ...minuteTimestamps.filter((value) => timestamp - value <= 5 * 60_000)];
    lastEventAt = timestamp;
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
  let eventsLastMinute = $derived(minuteTimestamps.filter((timestamp) => clock - timestamp <= 60_000).length);
  let eventsLastFiveMinutes = $derived(minuteTimestamps.filter((timestamp) => clock - timestamp <= 5 * 60_000).length);
  let activeSessions = $derived(sessions.filter((session) => clock - session.updatedAt <= 5 * 60_000).length);
  let eventTypeRows = $derived(
    Object.entries(eventCounts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10),
  );
  let hotSessions = $derived(
    sessions
      .map((session) => ({ ...session, events: sessionEventCounts[session.id] ?? 0 }))
      .sort((left, right) => right.events - left.events || right.updatedAt - left.updatedAt)
      .slice(0, 8),
  );

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
        pushEvent(payload);
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
      <p class="panel-subtitle">Real-time observability for the assistant's active OpenCode endpoint. Tracks live session events, recent session churn, and per-session activity through the existing brokered event stream.</p>
    </div>
    <div class="panel-header-actions">
      <button class="btn btn-secondary btn-sm" onclick={() => void loadSessions()} disabled={loading}>
        {#if loading}<Spinner />{/if}
        Refresh
      </button>
    </div>
  </div>

  {#if error}<div class="error-banner"><span>{error}</span></div>{/if}

  <div class="endpoint-banner">
    <div>
      <div class="endpoint-label">Endpoint</div>
      <div class="endpoint-value">{endpointsService.active?.label ?? 'Active assistant endpoint'}</div>
      <div class="endpoint-url">{endpointsService.active?.url ?? 'Loading endpoint URL…'}</div>
    </div>
    <div class="stream-badge stream-badge--{streamState}">{streamState}</div>
  </div>

  <div class="metric-grid">
    <div class="metric-card"><span>Tracked sessions</span><strong>{sessions.length}</strong><small>{activeSessions} active in last 5m</small></div>
    <div class="metric-card"><span>Events / minute</span><strong>{eventsLastMinute}</strong><small>{eventsLastFiveMinutes} in last 5m</small></div>
    <div class="metric-card"><span>Last event</span><strong>{fmtTime(lastEventAt)}</strong><small>{streamError || 'Stream healthy'}</small></div>
    <div class="metric-card"><span>Observed types</span><strong>{Object.keys(eventCounts).length}</strong><small>{eventFeed.length} recent events buffered</small></div>
  </div>

  <div class="activity-grid">
    <section class="card-section">
      <div class="card-head">
        <h3>Live Sessions</h3>
        <span>{sessions.length}</span>
      </div>
      <div class="session-list">
        {#if sessions.length === 0 && !loading}
          <div class="empty-card">No sessions found on the active OpenCode endpoint.</div>
        {/if}
        {#each sessions as session (session.id)}
          <button class:selected={selectedSessionId === session.id} class="session-row" onclick={() => void selectSession(session.id)}>
            <div>
              <div class="session-title">{session.title || 'Untitled session'}</div>
              <div class="session-meta mono">{session.id}</div>
            </div>
            <div class="session-stats">
              <span>{fmtDateTime(session.updatedAt)}</span>
              <strong>{sessionEventCounts[session.id] ?? 0} evt</strong>
            </div>
          </button>
        {/each}
      </div>
    </section>

    <section class="card-section">
      <div class="card-head">
        <h3>Live Event Feed</h3>
        <span>{eventFeed.length}</span>
      </div>
      <div class="feed-list">
        {#if eventFeed.length === 0}
          <div class="empty-card">Waiting for OpenCode events…</div>
        {/if}
        {#each eventFeed as event (event.id)}
          <div class="feed-row">
            <div class="feed-top">
              <span class="feed-type mono">{event.type}</span>
              <span class="feed-time">{fmtTime(event.timestamp)}</span>
            </div>
            <div class="feed-title">{event.title}</div>
            {#if event.detail}<div class="feed-detail">{event.detail}</div>{/if}
            {#if event.sessionId}<div class="feed-session mono">{event.sessionId}</div>{/if}
          </div>
        {/each}
      </div>
    </section>
  </div>

  <div class="details-grid">
    <section class="card-section">
      <div class="card-head">
        <h3>Selected Session</h3>
        {#if selectedSession}<span>{selectedSession.title || selectedSession.id}</span>{/if}
      </div>
      {#if selectedSession}
        <div class="selected-meta">
          <div><span>ID</span><strong class="mono">{selectedSession.id}</strong></div>
          <div><span>Created</span><strong>{fmtDateTime(selectedSession.createdAt)}</strong></div>
          <div><span>Updated</span><strong>{fmtDateTime(selectedSession.updatedAt)}</strong></div>
          <div><span>Events seen</span><strong>{sessionEventCounts[selectedSession.id] ?? 0}</strong></div>
        </div>
        <div class="message-panel">
          <div class="message-panel-head">
            <span>Recent messages</span>
            <button class="btn btn-ghost btn-sm" onclick={() => void loadMessages(selectedSession.id)} disabled={messagesLoading}>
              {#if messagesLoading}<Spinner />{/if}
              Refresh
            </button>
          </div>
          {#if selectedMessages.length === 0 && !messagesLoading}
            <div class="empty-card">No message or tool activity available for this session yet.</div>
          {/if}
          <div class="message-list">
            {#each selectedMessages.slice(-8).reverse() as message (message.id)}
              <div class="message-row">
                <div class="message-role">{message.type === 'divider' ? 'divider' : message.type === 'note' ? message.label.toLowerCase() : message.role}</div>
                <div class="message-text">{message.type === 'divider' ? message.label : message.text}</div>
              </div>
            {/each}
          </div>
        </div>
      {:else}
        <div class="empty-card">Select a session to inspect its recent messages.</div>
      {/if}
    </section>

    <section class="card-section">
      <div class="card-head">
        <h3>Event Breakdown</h3>
        <span>{eventTypeRows.length} types</span>
      </div>
      <table class="data-table">
        <thead>
          <tr><th>Event type</th><th>Total</th></tr>
        </thead>
        <tbody>
          {#if eventTypeRows.length === 0}
            <tr><td colspan="2" class="empty-cell">No events observed yet.</td></tr>
          {/if}
          {#each eventTypeRows as [type, count]}
            <tr><td class="mono">{type}</td><td>{count}</td></tr>
          {/each}
        </tbody>
      </table>

      <div class="hot-sessions">
        <h4>Most active sessions</h4>
        {#if hotSessions.length === 0}
          <div class="empty-card">No session activity captured yet.</div>
        {/if}
        {#each hotSessions as session (session.id)}
          <div class="hot-session-row">
            <div>
              <div class="session-title">{session.title || 'Untitled session'}</div>
              <div class="session-meta mono">{session.id}</div>
            </div>
            <strong>{session.events}</strong>
          </div>
        {/each}
      </div>
    </section>
  </div>
</div>

<style>
  .panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); flex-wrap: wrap; }
  .panel-subtitle { margin: var(--space-1) 0 0; font-size: var(--text-sm); color: var(--color-text-secondary); max-width: 80ch; }
  .panel-header-actions { display: flex; gap: var(--space-2); }
  .error-banner { background: var(--color-danger-subtle, rgba(239,68,68,0.1)); color: var(--color-danger, #ef4444); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); margin-bottom: var(--space-4); }
  .endpoint-banner { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: linear-gradient(135deg, color-mix(in srgb, var(--color-bg-secondary) 92%, transparent), color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-secondary))); margin-bottom: var(--space-4); flex-wrap: wrap; }
  .endpoint-label { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-text-secondary); }
  .endpoint-value { font-size: var(--text-lg); font-weight: var(--font-semibold); color: var(--color-text); }
  .endpoint-url { margin-top: var(--space-1); font-size: var(--text-xs); color: var(--color-text-secondary); font-family: var(--font-mono); }
  .stream-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 7rem; padding: var(--space-2) var(--space-3); border-radius: 999px; font-size: var(--text-xs); font-weight: var(--font-semibold); text-transform: uppercase; }
  .stream-badge--connected { background: rgba(34,197,94,0.14); color: #16a34a; }
  .stream-badge--connecting { background: rgba(245,158,11,0.14); color: #d97706; }
  .stream-badge--disconnected { background: rgba(239,68,68,0.14); color: #dc2626; }
  .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); margin-bottom: var(--space-4); }
  .metric-card { display: grid; gap: var(--space-1); padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-secondary); }
  .metric-card span { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-secondary); }
  .metric-card strong { font-size: clamp(1.3rem, 3vw, 1.9rem); color: var(--color-text); }
  .metric-card small { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .activity-grid, .details-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); margin-bottom: var(--space-4); }
  .card-section { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-secondary); padding: var(--space-4); min-width: 0; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-3); }
  .card-head h3, .hot-sessions h4 { margin: 0; font-size: var(--text-base); color: var(--color-text); }
  .card-head span { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .session-list, .feed-list, .message-list, .hot-sessions { display: flex; flex-direction: column; gap: var(--space-2); }
  .session-row, .feed-row, .hot-session-row { width: 100%; display: flex; justify-content: space-between; gap: var(--space-3); text-align: left; padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); color: var(--color-text); }
  .session-row { cursor: pointer; align-items: center; }
  .session-row.selected { border-color: var(--color-primary); box-shadow: inset 0 0 0 1px var(--color-primary); }
  .session-title, .feed-title { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); }
  .session-meta, .feed-session, .feed-type { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .session-stats { display: grid; justify-items: end; gap: var(--space-1); font-size: var(--text-xs); color: var(--color-text-secondary); }
  .feed-row { flex-direction: column; }
  .feed-top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
  .feed-detail, .message-text { font-size: var(--text-sm); color: var(--color-text-secondary); white-space: pre-wrap; word-break: break-word; }
  .feed-time { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .selected-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); margin-bottom: var(--space-4); }
  .selected-meta div { display: grid; gap: var(--space-1); padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); }
  .selected-meta span { font-size: var(--text-xs); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
  .selected-meta strong { font-size: var(--text-sm); color: var(--color-text); }
  .message-panel { border-top: 1px solid var(--color-border); padding-top: var(--space-3); }
  .message-panel-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-3); }
  .message-row { padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); }
  .message-role { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-secondary); margin-bottom: var(--space-1); }
  .data-table { width: 100%; border-collapse: collapse; }
  .data-table th, .data-table td { padding: var(--space-2) var(--space-1); border-bottom: 1px solid var(--color-border); text-align: left; font-size: var(--text-sm); color: var(--color-text); }
  .data-table th { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-secondary); }
  .empty-card, .empty-cell { font-size: var(--text-sm); color: var(--color-text-secondary); text-align: center; padding: var(--space-4); }
  .mono { font-family: var(--font-mono); }
  @media (max-width: 1100px) { .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .activity-grid, .details-grid { grid-template-columns: 1fr; } }
  @media (max-width: 640px) { .metric-grid, .selected-meta { grid-template-columns: 1fr; } }
</style>
