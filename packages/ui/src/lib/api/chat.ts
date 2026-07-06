import type { ChatEntry, OpenCodeMessageResponse, SessionSummary } from '../types.js';
import {
  flattenSessionMessages,
  type SessionMessageRow,
} from '$lib/chat/session-messages.js';
import { request, requireOk, readErrorMessage, buildHeaders } from './core.js';

// ── Chat Proxy ────────────────────────────────────────────────────────────────

/**
 * Create a new OpenCode session via the SvelteKit broker.
 *
 * Only `/proxy/assistant/*` is reachable from the browser. The active
 * OpenCode instance is selected server-side via the connection switcher.
 */
export async function createSession(): Promise<{ id: string }> {
  const res = await requireOk(
    await request('POST', `/proxy/assistant/session`, {})
  );
  return (await res.json()) as { id: string };
}

/**
 * List sessions on the active OpenCode endpoint.
 *
 * OpenCode returns `Array<Session>` with no ordering guarantee; we sort
 * desc by `time.updated` here so consumers can rely on it. See
 * docs/technical/multi-endpoint-session-ux.md §2.
 */
export async function listSessions(): Promise<SessionSummary[]> {
  const res = await requireOk(await request('GET', '/proxy/assistant/session'));
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
  const res = await requireOk(
    await request(
      'GET',
      `/proxy/assistant/session/${encodeURIComponent(sessionId)}/message`
    )
  );
  const rows = (await res.json()) as SessionMessageRow[];
  return flattenSessionMessages(rows);
}

/**
 * Send a message to an existing OpenCode session via the SvelteKit broker.
 * Uses direct fetch with a 150s AbortSignal timeout — OpenCode responses
 * can take 30–120s.
 */
export async function sendChatMessage(
  sessionId: string,
  text: string
): Promise<OpenCodeMessageResponse> {
  const res = await fetch(
    `/proxy/assistant/session/${encodeURIComponent(sessionId)}/message`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...buildHeaders(),
      },
      credentials: 'include',
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      signal: AbortSignal.timeout(150_000),
    }
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Sign-in required.'), { status: 401 });
  }
  if (!res.ok) {
    const msg = await readErrorMessage(res);
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return (await res.json()) as OpenCodeMessageResponse;
}

export async function startChatMessageTurn(
  sessionId: string,
  text: string
): Promise<void> {
  const res = await fetch(
    `/proxy/assistant/session/${encodeURIComponent(sessionId)}/message`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...buildHeaders(),
      },
      credentials: 'include',
      body: JSON.stringify({
        parts: [{ type: 'text', text }],
      }),
      signal: AbortSignal.timeout(150_000),
    }
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Sign-in required.'), { status: 401 });
  }
  if (!res.ok) {
    const msg = await readErrorMessage(res);
    throw Object.assign(new Error(msg), { status: res.status });
  }
}

/**
 * Abort the in-flight turn on an existing session via the SvelteKit broker.
 * Best-effort from the caller's perspective — OpenCode exposes this as
 * `POST /session/{id}/abort` (see `@opencode-ai/sdk` `session.abort`).
 */
export async function abortChatTurn(sessionId: string): Promise<void> {
  const res = await requireOk(
    await request(
      'POST',
      `/proxy/assistant/session/${encodeURIComponent(sessionId)}/abort`,
      {}
    )
  );
  await res.text().catch(() => '');
}

export async function replyChatPermission(
  requestId: string,
  reply: 'once' | 'always' | 'reject'
): Promise<void> {
  const res = await requireOk(
    await request('POST', `/proxy/assistant/permission/${encodeURIComponent(requestId)}/reply`, { reply })
  );
  await res.text().catch(() => '');
}

export async function replyChatQuestion(requestId: string, answers: string[][]): Promise<void> {
  const res = await requireOk(
    await request('POST', `/proxy/assistant/question/${encodeURIComponent(requestId)}/reply`, { answers })
  );
  await res.text().catch(() => '');
}

export async function rejectChatQuestion(requestId: string): Promise<void> {
  const res = await requireOk(
    await request('POST', `/proxy/assistant/question/${encodeURIComponent(requestId)}/reject`, {})
  );
  await res.text().catch(() => '');
}

/**
 * Probe whether the assistant broker is reachable.
 * Returns true if the probe succeeds within 3s.
 */
export async function probeChatBackend(): Promise<boolean> {
  try {
    const res = await fetch(`/proxy/assistant/provider`, {
      method: 'GET',
      headers: buildHeaders(),
      credentials: 'include',
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
