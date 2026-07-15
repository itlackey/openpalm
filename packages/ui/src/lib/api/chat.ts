import type { ChatEntry, OpenCodeMessageResponse, SessionSummary } from '../types.js';
import {
  flattenSessionMessages,
  type SessionMessageRow,
} from '$lib/chat/session-messages.js';
import { getTransport } from '$lib/connections/boot.js';

// ── Chat transport ─────────────────────────────────────────────────────────
//
// Phase 3b ("One UI, delete the split"): the browser talks to the active
// connection's OpenCode/Guardian base URL DIRECTLY via the shared direct
// transport (`$lib/connections/boot.getTransport()`) — no host proxy, no admin
// cookie (`credentials: 'omit'` lives in the transport). The active connection
// is chosen browser-side by the connection switcher. Exported function
// names/signatures are unchanged so `chat-state` and the chat components need
// no changes.

/** Create a new session on the active connection's OpenCode instance. */
export async function createSession(): Promise<{ id: string }> {
  const res = await getTransport().request('POST', '/session', {});
  return (await res.json()) as { id: string };
}

/**
 * List sessions on the active connection.
 *
 * OpenCode returns `Array<Session>` with no ordering guarantee; we sort
 * desc by `time.updated` here so consumers can rely on it. See
 * docs/technical/multi-endpoint-session-ux.md §2.
 */
export async function listSessions(): Promise<SessionSummary[]> {
  const res = await getTransport().request('GET', '/session');
  const raw = (await res.json()) as Array<{
    id: string;
    title?: string;
    time?: { created?: number; updated?: number };
  }>;
  const summaries: SessionSummary[] = raw.map((s) => ({
    id: s.id,
    title: s.title ?? '',
    createdAt: s.time?.created ?? 0,
    updatedAt: s.time?.updated ?? s.time?.created ?? 0,
  }));
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/**
 * Fetch the messages for a session and map them to UI `ChatEntry`s.
 *
 * The part-flattening/grouping logic lives in `flattenSessionMessages`
 * (`$lib/chat/session-messages.ts`) — this client only handles transport.
 */
export async function getSessionMessages(sessionId: string): Promise<ChatEntry[]> {
  const res = await getTransport().request(
    'GET',
    `/session/${encodeURIComponent(sessionId)}/message`
  );
  const rows = (await res.json()) as SessionMessageRow[];
  return flattenSessionMessages(rows);
}

/**
 * Send a message to an existing session and await the full response (the
 * non-streaming fallback used when the SSE event stream isn't connected).
 */
export async function sendChatMessage(
  sessionId: string,
  text: string
): Promise<OpenCodeMessageResponse> {
  const res = await getTransport().request(
    'POST',
    `/session/${encodeURIComponent(sessionId)}/message`,
    { parts: [{ type: 'text', text }] }
  );
  return (await res.json()) as OpenCodeMessageResponse;
}

/** Start a turn without awaiting the reply — the SSE stream carries deltas. */
export async function startChatMessageTurn(
  sessionId: string,
  text: string
): Promise<void> {
  await getTransport().request(
    'POST',
    `/session/${encodeURIComponent(sessionId)}/message`,
    { parts: [{ type: 'text', text }] }
  );
}

/**
 * Abort the in-flight turn on an existing session. Best-effort from the
 * caller's perspective — OpenCode exposes this as `POST /session/{id}/abort`.
 */
export async function abortChatTurn(sessionId: string): Promise<void> {
  const res = await getTransport().request(
    'POST',
    `/session/${encodeURIComponent(sessionId)}/abort`,
    {}
  );
  await res.text().catch(() => '');
}

export async function replyChatPermission(
  requestId: string,
  reply: 'once' | 'always' | 'reject'
): Promise<void> {
  const res = await getTransport().request(
    'POST',
    `/permission/${encodeURIComponent(requestId)}/reply`,
    { reply }
  );
  await res.text().catch(() => '');
}

export async function replyChatQuestion(requestId: string, answers: string[][]): Promise<void> {
  const res = await getTransport().request(
    'POST',
    `/question/${encodeURIComponent(requestId)}/reply`,
    { answers }
  );
  await res.text().catch(() => '');
}

export async function rejectChatQuestion(requestId: string): Promise<void> {
  const res = await getTransport().request(
    'POST',
    `/question/${encodeURIComponent(requestId)}/reject`,
    {}
  );
  await res.text().catch(() => '');
}

/**
 * Probe whether the active connection is reachable. Returns true only when the
 * direct health probe reports the endpoint as accessible.
 */
export async function probeChatBackend(): Promise<boolean> {
  const result = await getTransport().probeHealth();
  return result.status === 'accessible';
}
