<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Spinner from '@openpalm/ui-kit/components/common/Spinner.svelte';
  import ChatMessage from '$lib/components/chat/ChatMessage.svelte';
  import ToolStrip from '$lib/components/chat/ToolStrip.svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { getSessionMessages, listSessions } from '$lib/api.js';
  import type { ChatEntry, SessionSummary } from '$lib/types.js';
  import {
    subscribeSessionEvents,
    type OpenCodeSessionEventPayload,
  } from '$lib/chat/session-events.js';
  import {
    eventDetail,
    eventSessionId,
    eventTitle,
    summarizeEvent,
    toToolStripEntry,
    type ActivityEventProperties,
    type AttentionItem,
    type FeedItem,
  } from './activity-events.js';

  type StreamState = 'connecting' | 'connected' | 'disconnected';

  let loading = $state(false);
  let messagesLoading = $state(false);
  let error = $state('');
  let streamError = $state('');
  let streamState = $state<StreamState>('connecting');
  let sessions = $state<SessionSummary[]>([]);
  let selectedSessionId = $state<string | null>(null);
  let selectedMessages = $state<ChatEntry[]>([]);
  let attentionFeed = $state<AttentionItem[]>([]);
  let eventFeed = $state<FeedItem[]>([]);
  let eventCounts = $state<Record<string, number>>({});
  let sessionEventCounts = $state<Record<string, number>>({});
  let minuteTimestamps = $state<number[]>([]);
  let lastEventAt = $state<number | null>(null);
  let clock = $state(Date.now());

  let unsubscribe: (() => void) | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let clockTimer: ReturnType<typeof setInterval> | null = null;

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

  function pushEvent(payload: OpenCodeSessionEventPayload): void {
    const timestamp = Date.now();
    const type = payload.type || 'unknown';
    const sessionId = eventSessionId(payload);
    const toolState = toToolStripEntry(payload) ?? undefined;
    eventFeed = [
      {
        id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        sessionId,
        title: eventTitle(payload),
        detail: eventDetail(payload),
        toolState,
        timestamp,
      },
      ...eventFeed,
    ].slice(0, 80);
    eventCounts = { ...eventCounts, [type]: (eventCounts[type] ?? 0) + 1 };
    if (sessionId) {
      sessionEventCounts = { ...sessionEventCounts, [sessionId]: (sessionEventCounts[sessionId] ?? 0) + 1 };
    }
    minuteTimestamps = [timestamp, ...minuteTimestamps.filter((value) => timestamp - value <= 5 * 60_000)];
    lastEventAt = timestamp;
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
    const props = payload.properties as ActivityEventProperties | undefined;
    const info = props?.info;
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
    const d = new Date(timestamp);
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtDateTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  let selectedSession = $derived(sessions.find((session) => session.id === selectedSessionId) ?? null);
  let waitingItems = $derived(attentionFeed.filter((item) => item.kind === 'permission' || item.kind === 'question').length);
  let failingItems = $derived(attentionFeed.filter((item) => item.severity === 'high').length);
  let activeSessions = $derived(sessions.filter((session) => clock - session.updatedAt <= 5 * 60_000).length);
  let latestAttention = $derived(attentionFeed.slice(0, 10));
  let eventsLastMinute = $derived(minuteTimestamps.filter((timestamp) => clock - timestamp <= 60_000).length);
  let eventsLastFiveMinutes = $derived(minuteTimestamps.filter((timestamp) => clock - timestamp <= 5 * 60_000).length);
  let eventTypeRows = $derived(
    Object.entries(eventCounts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8),
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
        pushAttention(payload);
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
      <p class="panel-subtitle">Operator telemetry · live</p>
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

  <div class="endpoint-banner">
    <div>
      <div class="endpoint-label">Endpoint</div>
      <div class="endpoint-value">{endpointsService.active?.label ?? 'Active assistant endpoint'}</div>
      <div class="endpoint-url mono">{endpointsService.active?.url ?? 'Loading endpoint URL...'}</div>
    </div>
    <div class="stream-badge stream-badge--{streamState}">{streamState}</div>
  </div>

  <div class="summary-grid">
    <div class="summary-card">
      <span class="summary-label">Events / minute</span>
      <strong class="summary-value">{eventsLastMinute}</strong>
      <small>{eventsLastFiveMinutes} events seen in the last 5 minutes</small>
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
      <span class="summary-label">Last event</span>
      <strong class="summary-value summary-value--small">{fmtTime(lastEventAt)}</strong>
      <small>{failingItems > 0 ? `${failingItems} failure${failingItems === 1 ? '' : 's'} need review.` : streamState === 'connected' ? 'Stream healthy.' : 'Reconnect needed.'}</small>
    </div>
    <div class="summary-card">
      <span class="summary-label">Observed types</span>
      <strong class="summary-value">{Object.keys(eventCounts).length}</strong>
      <small>{eventFeed.length} recent events buffered</small>
    </div>
    <div class="summary-card" class:summary-card--danger={failingItems > 0}>
      <span class="summary-label">Failures seen</span>
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
              {@const sessionTitle = sessions.find((s) => s.id === item.sessionId)?.title}
              <button
                class="attention-session mono"
                type="button"
                aria-label={item.sessionId}
                onclick={() => void selectSession(item.sessionId)}
              >
                {sessionTitle || `Session ${item.sessionId.slice(0, 8)}…`}
              </button>
            {/if}
          </article>
        {/each}
      </div>

      <div class="subsection-head">
        <h4>Live event feed</h4>
        <span>{eventFeed.length}</span>
      </div>
      <div class="feed-list">
        {#if eventFeed.length === 0}
          <div class="empty-card">Waiting for OpenCode events...</div>
        {/if}
        {#each eventFeed.slice(0, 12) as event (event.id)}
          <article class="feed-row">
            <div class="feed-top">
              <span class="feed-type mono">{event.type}</span>
              <span>{fmtTime(event.timestamp)}</span>
            </div>
            <strong>{event.title}</strong>
            {#if event.toolState}
              <ToolStrip items={[event.toolState]} ariaLabel="Activity tool event" />
            {:else if event.detail}
              <p>{event.detail}</p>
            {/if}
            {#if event.sessionId}
              {@const sessionTitle = sessions.find((s) => s.id === event.sessionId)?.title}
              <button
                class="attention-session mono"
                type="button"
                aria-label={event.sessionId}
                onclick={() => void selectSession(event.sessionId)}
              >
                {sessionTitle || `Session ${event.sessionId.slice(0, 8)}…`}
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
            <div class="session-stats">
              <strong>{sessionEventCounts[session.id] ?? 0} evt</strong>
              <span class="session-id mono">{session.id.slice(0, 12)}...</span>
            </div>
          </button>
        {/each}
      </div>

      <div class="subsection-head">
        <h4>Event breakdown</h4>
        <span>{eventTypeRows.length}</span>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr><th>Type</th><th>Total</th></tr>
          </thead>
          <tbody>
            {#if eventTypeRows.length === 0}
              <tr><td colspan="2" class="empty-cell">No events observed yet.</td></tr>
            {/if}
            {#each eventTypeRows as [type, count] (type)}
              <tr>
                <td class="mono">{type}</td>
                <td>{count}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="subsection-head">
        <h4>Most active sessions</h4>
        <span>{hotSessions.length}</span>
      </div>
      <div class="hot-session-list">
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
        <div><span>Events seen</span><strong>{sessionEventCounts[selectedSession.id] ?? 0}</strong></div>
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
  .error-banner { color: var(--s-seal); padding: var(--s-sp-2) var(--s-sp-3); border: var(--s-hair) solid var(--s-seal); border-radius: 2px; margin-bottom: var(--s-sp-4); font-family: var(--s-font-display); font-size: var(--s-type-deed); }
  .endpoint-banner { display: flex; align-items: center; justify-content: space-between; gap: var(--s-sp-4); padding: var(--s-sp-3) var(--s-sp-5); border: var(--s-hair) solid var(--s-line-soft); background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper)); margin-bottom: var(--s-sp-4); flex-wrap: wrap; border-radius: 2px; }
  .endpoint-label { font-family: var(--s-font-mono); font-size: var(--s-type-mark); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-ink-3); }
  .endpoint-value { font-family: var(--s-font-display); font-size: var(--s-type-voice); font-weight: 400; color: var(--s-ink); margin-top: var(--s-sp-1); }
  .endpoint-url { margin-top: var(--s-sp-1); font-family: var(--s-font-mono); font-size: var(--s-type-deed); color: var(--s-ink-2); }
  .stream-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 7rem; padding: var(--s-sp-2) var(--s-sp-3); border: var(--s-hair) solid currentColor; border-radius: 2px; font-family: var(--s-font-mono); font-size: var(--s-type-mark); letter-spacing: var(--s-track-label); text-transform: uppercase; }
  .stream-badge--connected { color: var(--s-moss); }
  .stream-badge--connecting { color: var(--s-ink-3); }
  .stream-badge--disconnected { color: var(--s-seal); }
  .summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-sp-3); margin-bottom: var(--s-sp-4); }
  .summary-card { display: grid; gap: var(--s-sp-1); padding: var(--s-sp-4); border: var(--s-hair) solid var(--s-line-soft); background: var(--s-paper-deep); border-radius: 2px; }
  .summary-card--warning { border-color: var(--s-seal); }
  .summary-card--danger { border-color: var(--s-seal); }
  .summary-label { font-family: var(--s-font-mono); font-size: var(--s-type-mark); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-ink-3); }
  .summary-value { font-family: var(--s-font-display); font-size: clamp(1.2rem, 3vw, 1.9rem); color: var(--s-ink); }
  .summary-value--small { font-size: clamp(1rem, 2vw, 1.35rem); }
  .summary-card small { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-2); }
  .activity-layout { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: var(--s-sp-4); margin-bottom: var(--s-sp-4); }
  .card-section { border: var(--s-hair) solid var(--s-line-soft); background: var(--s-paper-deep); padding: var(--s-sp-4); min-width: 0; border-radius: 2px; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s-sp-2); margin-bottom: var(--s-sp-3); }
  .card-head h3 { margin: 0; font-family: var(--s-font-mono); font-size: var(--s-type-mark); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-ink-3); }
  .card-head span { font-family: var(--s-font-mono); font-size: var(--s-type-mark); color: var(--s-ink-3); }
  .subsection-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s-sp-2); margin: var(--s-sp-4) 0 var(--s-sp-2); }
  .subsection-head h4 { margin: 0; font-family: var(--s-font-mono); font-size: var(--s-type-mark); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-ink-3); }
  .subsection-head span { font-family: var(--s-font-mono); font-size: var(--s-type-mark); color: var(--s-ink-3); }
  .attention-list, .session-list, .selected-message-list, .feed-list, .hot-session-list { display: flex; flex-direction: column; gap: var(--s-sp-2); }
  .attention-item { padding: var(--s-sp-3); border: var(--s-hair) solid var(--s-line-soft); background: var(--s-paper); border-radius: 2px; }
  .attention-item--high { border-color: var(--s-seal); }
  .attention-item--medium { border-color: color-mix(in srgb, var(--s-seal) 45%, var(--s-line)); }
  .attention-top { display: flex; align-items: center; justify-content: space-between; gap: var(--s-sp-2); margin-bottom: var(--s-sp-1); }
  .attention-top strong { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink); }
  .attention-top span { font-family: var(--s-font-mono); font-size: var(--s-type-mark); color: var(--s-ink-3); }
  .attention-item p { margin: 0; font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-2); }
  .attention-session { margin-top: var(--s-sp-2); border: 0; background: transparent; color: var(--s-ink-2); padding: 0; cursor: pointer; text-align: left; word-break: break-all; max-width: 100%; font-family: var(--s-font-mono); font-size: var(--s-type-mark); }
  .session-row { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: var(--s-sp-3); text-align: left; padding: var(--s-sp-3); border: var(--s-hair) solid var(--s-line-soft); background: var(--s-paper); color: var(--s-ink); cursor: pointer; border-radius: 2px; appearance: none; }
  .session-row:hover { background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper)); }
  .session-row.selected { border-color: var(--s-ink-2); }
  .session-title { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink); }
  .session-meta { font-family: var(--s-font-mono); font-size: var(--s-type-mark); color: var(--s-ink-3); }
  .session-id { font-family: var(--s-font-mono); font-size: var(--s-type-mark); color: var(--s-ink-3); }
  .session-stats { display: grid; justify-items: end; gap: var(--s-sp-1); }
  .feed-row { padding: var(--s-sp-3); border: var(--s-hair) solid var(--s-line-soft); background: var(--s-paper); display: grid; gap: var(--s-sp-1); border-radius: 2px; }
  .feed-top { display: flex; align-items: center; justify-content: space-between; gap: var(--s-sp-2); }
  .feed-type, .feed-top span:last-child { font-family: var(--s-font-mono); font-size: var(--s-type-mark); color: var(--s-ink-3); }
  .feed-row strong { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink); }
  .feed-row p { margin: 0; font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-2); }
  .table-scroll { overflow-x: auto; }
  .data-table { width: 100%; border-collapse: collapse; }
  .data-table th, .data-table td { padding: var(--s-sp-2) var(--s-sp-1); border-bottom: var(--s-hair) solid var(--s-line-soft); text-align: left; font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink); }
  .data-table tr:hover td { background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper)); }
  .data-table th { font-family: var(--s-font-mono); font-size: var(--s-type-mark); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-ink-3); }
  .hot-session-row { display: flex; justify-content: space-between; gap: var(--s-sp-3); padding: var(--s-sp-3); border-bottom: var(--s-hair) solid var(--s-line-soft); }
  .selected-meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s-sp-3); margin-bottom: var(--s-sp-4); }
  .selected-meta div { display: grid; gap: var(--s-sp-1); padding: var(--s-sp-3); border: var(--s-hair) solid var(--s-line-soft); background: var(--s-paper); border-radius: 2px; }
  .selected-meta span { font-family: var(--s-font-mono); font-size: var(--s-type-mark); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-ink-3); }
  .selected-meta strong { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink); }
  .message-panel-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s-sp-2); margin-bottom: var(--s-sp-3); }
  .empty-card, .empty-cell { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-3); text-align: center; padding: var(--s-sp-4); border: var(--s-hair) solid var(--s-line-soft); border-radius: 2px; }
  .mono { font-family: var(--s-font-mono); }
  @media (max-width: 1100px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .activity-layout { grid-template-columns: 1fr; } .selected-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .summary-grid, .selected-meta { grid-template-columns: 1fr; } }
</style>
