/**
 * Guardian-signed native OpenCode client (design §2, §3.1, §4.2).
 *
 * Channels speak NATIVE OpenCode through the guardian's /oc/* reverse proxy,
 * NOT the buffered /channel/inbound envelope. Every call is HMAC-signed per the
 * §3.1 scheme (method + path+query + SHA256(body) + nonce + timestamp + userId),
 * with `userId` a mandatory signed positional field. The wire headers exactly
 * match what core/guardian/src/proxy.ts reads.
 *
 * This is the SHARED piece (channels-sdk) that any channel renderer builds on —
 * mirroring the design's "shared pure crypto + path matcher in channels-sdk,
 * guardian-runtime state local to core/guardian" placement (§2.2). It holds NO
 * cross-tenant runtime state; it is a per-channel signing HTTP client + an SSE
 * line reader for the filtered /event stream.
 *
 * The OpenCode wire TYPES (`Event`, `Part`, `Permission`, …) come from
 * `@opencode-ai/sdk` — the versioned upstream contract — so channels render
 * native objects instead of a re-encoded protocol (design §0).
 */

import type { Event } from "@opencode-ai/sdk";
import { signRequest } from "./crypto.ts";

/** The guardian's /oc base, hardcoded like guardianUrl in channel-sdk.ts (no env override by design). */
const GUARDIAN_OC_BASE = "http://guardian:8080/oc";

// Wire header names — MUST match core/guardian/src/proxy.ts.
const H_SIG = "x-channel-signature";
const H_CHANNEL = "x-channel-name";
const H_USER = "x-channel-user-id";
const H_NONCE = "x-channel-nonce";
const H_TIMESTAMP = "x-channel-timestamp";
const H_SESSION_KEY = "x-channel-session-key";

export interface OcClientOptions {
  /** The channel name (e.g. "discord") — used as the secret-map key + signed material. */
  channel: string;
  /** The per-channel HMAC secret (read from CHANNEL_SECRET_FILE by the adapter). */
  secret: string;
  /** Override the guardian /oc base (tests only; production uses the hardcoded default). */
  baseUrl?: string;
}

/** A minimal OpenCode Session shape (the create/get response we read). */
export interface OcSession {
  id: string;
  title?: string;
}

/**
 * Sign + issue ONE native OpenCode call through the guardian proxy.
 *
 * `userId` scopes ownership within the channel (e.g. "discord:123"). `ocPath` is
 * the OpenCode path WITHOUT the /oc prefix (e.g. "/session/abc/prompt_async").
 * Fresh nonce + timestamp per call (permission replies in particular MUST NOT
 * reuse the prompt_async nonce — §3.1).
 */
export class OcClient {
  private readonly channel: string;
  private readonly secret: string;
  private readonly base: string;

  constructor(opts: OcClientOptions) {
    this.channel = opts.channel;
    this.secret = opts.secret;
    this.base = opts.baseUrl ?? GUARDIAN_OC_BASE;
  }

  private headers(
    method: string,
    ocPath: string,
    body: string,
    userId: string,
    extra?: Record<string, string>,
  ): Headers {
    const nonce = crypto.randomUUID();
    const timestamp = Date.now();
    const sig = signRequest(this.secret, { method, pathWithQuery: ocPath, body, nonce, timestamp, userId });
    const headers = new Headers({
      [H_SIG]: sig,
      [H_CHANNEL]: this.channel,
      [H_USER]: userId,
      [H_NONCE]: nonce,
      [H_TIMESTAMP]: String(timestamp),
    });
    if (body) headers.set("content-type", "application/json");
    if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return headers;
  }

  /** Low-level signed fetch. `ocPath` is the OpenCode path (no /oc prefix). */
  async call(
    method: string,
    ocPath: string,
    userId: string,
    body?: unknown,
    opts: { sessionKey?: string; signal?: AbortSignal; accept?: string } = {},
  ): Promise<Response> {
    const bodyStr = body === undefined ? "" : JSON.stringify(body);
    const extra: Record<string, string> = {};
    if (opts.sessionKey) extra[H_SESSION_KEY] = opts.sessionKey;
    if (opts.accept) extra["accept"] = opts.accept;
    const headers = this.headers(method, ocPath, bodyStr, userId, extra);
    const init: RequestInit = { method, headers, signal: opts.signal };
    if (method !== "GET" && method !== "HEAD") init.body = bodyStr;
    return fetch(`${this.base}${ocPath}`, init);
  }

  /**
   * POST /session — the guardian REWRITES the title from the principal-derived
   * sessionKey and discards any client title (§3.4), so we send an empty body
   * and pass sessionKey as a header for the guardian's grouping.
   */
  async createSession(userId: string, sessionKey?: string): Promise<OcSession> {
    const resp = await this.call("POST", "/session", userId, {}, { sessionKey });
    if (!resp.ok) throw new Error(`createSession failed: ${resp.status}`);
    return (await resp.json()) as OcSession;
  }

  /**
   * Send a user turn and render via the persistent /event subscription (not this
   * response). Two hard-won OpenCode 1.15.13 facts are baked in:
   *
   *  1. Uses the BLOCKING /session/{id}/message endpoint, NOT prompt_async —
   *     prompt_async only fires the FIRST turn of a session; follow-ups no-op.
   *  2. Does NOT send a client-supplied `messageID`. A client messageID makes
   *     OpenCode silently no-op every FOLLOW-UP turn on the same session (the
   *     user message is added but the model never generates). Letting OpenCode
   *     mint the id fixes multi-turn. Correlation is by sessionID anyway (§4.2),
   *     so the client id was never needed.
   *
   * The HTTP response resolves at TURN-END, so the streaming renderer fires this
   * WITHOUT awaiting and drives off /event.
   */
  async prompt(userId: string, sessionId: string, text: string): Promise<void> {
    const resp = await this.call(
      "POST",
      `/session/${sessionId}/message`,
      userId,
      { parts: [{ type: "text", text }] },
    );
    if (!resp.ok) throw new Error(`prompt failed: ${resp.status}`);
  }

  /** POST /permission/{requestID}/reply — fresh-signed; ownership-checked by the guardian. */
  async replyPermission(
    userId: string,
    requestID: string,
    reply: "once" | "always" | "reject",
    message?: string,
  ): Promise<boolean> {
    const body: Record<string, unknown> = { reply };
    if (message) body.message = message;
    const resp = await this.call("POST", `/permission/${requestID}/reply`, userId, body);
    if (!resp.ok) throw new Error(`replyPermission failed: ${resp.status}`);
    return true;
  }

  /**
   * POST /question/{requestID}/reply — answer the interactive `question` tool
   * (the parallel of replyPermission). `answers` is one entry per question, each
   * an array of chosen labels / free-text strings. Fresh-signed; the guardian
   * ownership-checks the requestID (recorded when it relayed question.asked).
   */
  async replyQuestion(userId: string, requestID: string, answers: string[][]): Promise<boolean> {
    const resp = await this.call("POST", `/question/${requestID}/reply`, userId, { answers });
    if (!resp.ok) throw new Error(`replyQuestion failed: ${resp.status}`);
    return true;
  }

  /** POST /question/{requestID}/reject — decline an interactive question (e.g.
   * a non-interactive channel with no human to answer). */
  async rejectQuestion(userId: string, requestID: string): Promise<void> {
    const resp = await this.call("POST", `/question/${requestID}/reject`, userId, {});
    if (!resp.ok) throw new Error(`rejectQuestion failed: ${resp.status}`);
  }

  /** POST /session/{id}/abort — stop an in-flight turn (the "Stop" button). */
  async abort(userId: string, sessionId: string): Promise<void> {
    const resp = await this.call("POST", `/session/${sessionId}/abort`, userId, {});
    if (!resp.ok) throw new Error(`abort failed: ${resp.status}`);
  }

  /** DELETE /session/{id}. */
  async deleteSession(userId: string, sessionId: string): Promise<void> {
    await this.call("DELETE", `/session/${sessionId}`, userId);
  }

  /**
   * Open the filtered SSE /event stream for this principal and yield each parsed
   * native OpenCode `Event`. The guardian forwards ONLY frames whose sessionID
   * this principal owns (§3.2); the renderer narrows further to its own session
   * (correlation is by sessionID — §4.2). One persistent subscription per
   * principal — open it ONCE, before the first prompt_async, to remove the
   * subscribe-after-prompt race.
   *
   * Closes when `signal` aborts. Yields raw `Event` objects (callers narrow by
   * `event.type`).
   */
  async *events(userId: string, signal: AbortSignal): AsyncGenerator<Event> {
    const resp = await this.call("GET", "/event", userId, undefined, {
      signal,
      accept: "text/event-stream",
    });
    if (!resp.ok || !resp.body) throw new Error(`events open failed: ${resp.status}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = extractSseData(frame);
          if (data === null) continue;
          let parsed: Event | null = null;
          try {
            parsed = JSON.parse(data) as Event;
          } catch {
            parsed = null; // tolerate a malformed/partial frame
          }
          if (parsed) yield parsed;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
    }
  }
}

/** Extract the concatenated `data:` payload of one SSE frame; null for comment-only frames. */
function extractSseData(frame: string): string | null {
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
  }
  return dataLines.length === 0 ? null : dataLines.join("\n");
}

/**
 * Generate a messageID to pass to `prompt_async`. OpenCode uses the `msg_`
 * prefix convention and accepts a client-supplied id for the USER message (it
 * still assigns the assistant reply its own server id — see extractTextDelta,
 * which is why turn correlation is sessionID-based, not by this id). A `msg_`
 * prefix avoids any chance of OpenCode rejecting a non-conventional id.
 */
export function generateMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}
