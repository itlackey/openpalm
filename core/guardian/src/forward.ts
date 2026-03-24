/**
 * Assistant forwarding — session management and message routing.
 *
 * Manages session lifecycle (create, reuse, clear) with caching and
 * per-key locking to avoid duplicate session creation under concurrent
 * requests. Uses the shared assistant HTTP client from channels-sdk.
 */

import {
  createSession,
  deleteSession,
  listSessions,
  sendMessage,
} from "@openpalm/channels-sdk/assistant-client";
import type { AssistantClientOptions } from "@openpalm/channels-sdk/assistant-client";
import { asRecord } from "@openpalm/channels-sdk/utils";

// ── Config ──────────────────────────────────────────────────────────────

const ASSISTANT_URL = Bun.env.OP_ASSISTANT_URL ?? "http://assistant:4096";
const MESSAGE_TIMEOUT = Number(Bun.env.OPENCODE_TIMEOUT_MS ?? 0);
const SESSION_TTL_MS = Number(Bun.env.GUARDIAN_SESSION_TTL_MS ?? 15 * 60_000);
const SESSION_KEY_MAX_LENGTH = 256;

// ── Session cache ───────────────────────────────────────────────────────

const sessionCache = new Map<string, { sessionId: string; lastUsed: number }>();
const sessionLocks = new Map<string, Promise<unknown>>();

// Periodic cleanup of expired sessions + hard cap at 10,000
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessionCache) {
    if (now - entry.lastUsed > SESSION_TTL_MS) sessionCache.delete(key);
  }

  // Hard cap: if still over 10,000 after pruning expired, delete oldest entries first
  if (sessionCache.size > 10_000) {
    const sorted = [...sessionCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toRemove = sorted.slice(0, sorted.length - 10_000);
    for (const [k] of toRemove) sessionCache.delete(k);
  }
}, 5 * 60_000);

// ── Session title cache (for reattaching to existing assistant sessions) ──

const SESSION_LIST_CACHE_TTL_MS = 60_000;
const sessionTitleCache = new Map<string, string>();
let sessionListCacheLastLoaded = 0;

// ── Types ───────────────────────────────────────────────────────────────

export type SessionTarget = {
  cacheKey: string;
  sessionKey: string;
  title: string;
};

// ── Public API ──────────────────────────────────────────────────────────

export function resolveSessionTarget(userId: string, channel: string, metadata: unknown): SessionTarget {
  const meta = asRecord(metadata);
  const metadataSessionKey = typeof meta?.sessionKey === "string"
    ? meta.sessionKey.trim()
    : "";
  const sessionKey = metadataSessionKey && metadataSessionKey.length <= SESSION_KEY_MAX_LENGTH
    ? metadataSessionKey
    : userId;

  return {
    cacheKey: `${channel}:${sessionKey}`,
    sessionKey,
    title: `${channel}/${sessionKey}`,
  };
}

export function shouldClearSession(metadata: unknown): boolean {
  return asRecord(metadata)?.clearSession === true;
}

export async function askAssistant(
  message: string,
  sessionTarget: SessionTarget,
): Promise<{ answer: string; sessionId: string }> {
  return withSessionLock(sessionTarget.cacheKey, async () => {
    const cacheKey = sessionTarget.cacheKey;
    const opts = clientOpts();
    const cached = sessionCache.get(cacheKey);

    if (cached && Date.now() - cached.lastUsed < SESSION_TTL_MS) {
      try {
        const answer = await sendMessage(opts, cached.sessionId, message);
        cached.lastUsed = Date.now();
        sessionTitleCache.set(sessionTarget.title, cached.sessionId);
        return { answer, sessionId: cached.sessionId };
      } catch {
        sessionCache.delete(cacheKey);
      }
    }

    const existingSessionId = await findExistingSessionId(sessionTarget);
    if (existingSessionId) {
      try {
        const answer = await sendMessage(opts, existingSessionId, message);
        sessionCache.set(cacheKey, { sessionId: existingSessionId, lastUsed: Date.now() });
        sessionTitleCache.set(sessionTarget.title, existingSessionId);
        return { answer, sessionId: existingSessionId };
      } catch {
        sessionCache.delete(cacheKey);
      }
    }

    const sessionId = await createSession(opts, sessionTarget.title);
    const answer = await sendMessage(opts, sessionId, message);
    sessionCache.set(cacheKey, { sessionId, lastUsed: Date.now() });
    sessionTitleCache.set(sessionTarget.title, sessionId);
    return { answer, sessionId };
  });
}

export async function clearAssistantSessions(sessionTarget: SessionTarget): Promise<void> {
  await withSessionLock(sessionTarget.cacheKey, async () => {
    sessionCache.delete(sessionTarget.cacheKey);
    sessionTitleCache.delete(sessionTarget.title);
    // Force the next findExistingSessionId to re-fetch the session list
    sessionListCacheLastLoaded = 0;

    const opts = clientOpts();
    const sessions = await listSessions(opts);
    const matching = sessions.filter((session) => session.title === sessionTarget.title);

    for (const session of matching) {
      try {
        await deleteSession(opts, session.id);
      } catch {
        // best-effort cleanup; cache removal already ensures a fresh mapping next turn
      }
    }
  });
}

/** Expose active session count for the /stats endpoint. */
export function sessionCacheSize(): number {
  return sessionCache.size;
}

/** Expose session TTL for the /stats endpoint. */
export { SESSION_TTL_MS };

// ── Internal helpers ────────────────────────────────────────────────────

function clientOpts(): AssistantClientOptions {
  return {
    baseUrl: ASSISTANT_URL,
    username: Bun.env.OPENCODE_SERVER_USERNAME ?? "opencode",
    password: Bun.env.OPENCODE_SERVER_PASSWORD,
    messageTimeoutMs: MESSAGE_TIMEOUT,
  };
}

async function withSessionLock<T>(cacheKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(cacheKey) ?? Promise.resolve();

  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = current.catch(() => {});
  sessionLocks.set(cacheKey, chain);

  await previous.catch(() => {});

  try {
    return await fn();
  } finally {
    release();
    if (sessionLocks.get(cacheKey) === chain) {
      sessionLocks.delete(cacheKey);
    }
  }
}

async function findExistingSessionId(sessionTarget: SessionTarget): Promise<string | null> {
  const now = Date.now();
  const cachedId = sessionTitleCache.get(sessionTarget.title);
  if (cachedId && now - sessionListCacheLastLoaded < SESSION_LIST_CACHE_TTL_MS) {
    return cachedId;
  }

  // Re-fetch if TTL expired OR if the title is not in the cache (a miss
  // should trigger a refresh so externally-created sessions are discovered).
  if (!cachedId || now - sessionListCacheLastLoaded >= SESSION_LIST_CACHE_TTL_MS) {
    const opts = clientOpts();
    const sessions = await listSessions(opts);

    sessionTitleCache.clear();
    for (const session of sessions) {
      if (session.title) {
        sessionTitleCache.set(session.title, session.id);
      }
    }

    sessionListCacheLastLoaded = now;
  }

  return sessionTitleCache.get(sessionTarget.title) ?? null;
}
