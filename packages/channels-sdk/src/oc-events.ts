/**
 * Shared pure OpenCode /event frame interpreters (design §1.1, §4.2).
 *
 * Channel renderers (Discord §4.1, Slack §4.3, …) all consume the SAME native
 * OpenCode `Event` union from the guardian's filtered /event stream and must
 * correlate frames identically: by `sessionID` AND the channel-generated
 * `messageID` (§4.2), with the same turn-end / tool-update / permission-ask
 * interpretation (§1.1). That logic is platform-agnostic and pure, so it lives
 * here (channels-sdk) and is reused by every renderer rather than duplicated per
 * channel — mirroring the "shared pure logic in channels-sdk" placement (§2.2).
 *
 * These functions are PURE: no I/O, deterministic, fully unit-testable. They
 * narrow the OpenCode wire shape defensively (`event.type` + property probing)
 * and tolerate unknown event shapes for graceful OpenCode-version degrade (§5).
 * Platform rendering (Discord embeds, Slack Block Kit) stays in each adapter.
 */

/** A minimally-narrowed OpenCode event frame: `{ type, properties }` (§1.1). */
export interface RawEvent {
  type: string;
  properties?: Record<string, unknown>;
}

/** Coerce any value into a RawEvent shape (defensive — runtime surface is the contract). */
export function asRaw(ev: unknown): RawEvent {
  const e = ev as RawEvent;
  return {
    type: typeof e?.type === "string" ? e.type : "",
    properties: (e?.properties ?? {}) as Record<string, unknown>,
  };
}

function propStr(props: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = props?.[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Extract a text delta from any supported delta event family, correlated to our
 * session. Returns null if the frame is for a different session, is not a text
 * delta, or carries no delta. Prefers the fine-grained 1.15.13
 * `session.next.text.delta`, falling back to `message.part.delta` on a text
 * field (§1.1).
 *
 * Correlation is **by sessionID only — NOT by the client-supplied messageID.**
 * Live capture (2026-06-04) proved the assistant's reply deltas carry a
 * SERVER-generated messageID (`msg_…`), not the id the client passed to
 * `prompt_async` (that id appears only on the echoed user message). So filtering
 * deltas by the client messageID would drop the entire assistant stream. Turns
 * are already serialized per session (the channel's ConversationQueue) and the
 * guardian ownership-filters `/event` by session, so the session is the correct
 * and sufficient correlation key for a turn's deltas (§4.2, corrected).
 */
export function extractTextDelta(e: RawEvent, sessionId: string): string | null {
  const props = e.properties ?? {};
  if (propStr(props, "sessionID") !== sessionId) return null;

  // Preferred: fine-grained 1.15.13 stream.
  if (e.type === "session.next.text.delta") {
    return propStr(props, "delta") ?? propStr(props, "text") ?? null;
  }
  // Fallback: message.part.delta on a text field.
  if (e.type === "message.part.delta") {
    if (propStr(props, "field") && propStr(props, "field") !== "text") return null;
    return propStr(props, "delta") ?? null;
  }
  return null;
}

/**
 * The explicit `session.status` values that mean "this turn is over" (§1.1).
 *
 * IMPORTANT: only an EXPLICIT idle status ends a turn. A `session.status` frame
 * whose `status` is missing/empty/unknown is an intermediate or partial frame
 * and must NOT be treated as turn-end — doing so cuts the render off mid-stream
 * (the §4.2 "pin the exact end-of-turn condition empirically" open question).
 * `session.idle` remains the unambiguous fallback. The exact 1.15.13 idle marker
 * is being pinned against a live stream; add any observed terminal value here.
 */
export const TURN_IDLE_STATUSES: ReadonlySet<string> = new Set(["idle", "completed", "done"]);

/**
 * The `session.status` `status` field on a live OpenCode 1.15.13 server is an
 * OBJECT `{ type: "busy" | "idle" }` — NOT a bare string. (Verified against a
 * live 1.15.13 /event stream, 2026-06-04.) Older/other shapes may carry a bare
 * string, so read either: an object's `.type`, or the string itself. Returns the
 * status name, or undefined if absent/unreadable (→ NOT turn-end).
 */
export function statusName(status: unknown): string | undefined {
  if (typeof status === "string") return status;
  if (status && typeof status === "object" && typeof (status as { type?: unknown }).type === "string") {
    return (status as { type: string }).type;
  }
  return undefined;
}

/** Is this the turn-end signal for our session? (§1.1 — session.status idle, fallback session.idle.) */
export function isTurnEnd(e: RawEvent, sessionId: string): boolean {
  if (propStr(e.properties, "sessionID") !== sessionId) return false;
  if (e.type === "session.idle") return true;
  if (e.type === "session.status") {
    // status is `{type:"idle"}` on live 1.15.13 (or a bare string elsewhere).
    // Only an explicit idle status ends the turn (see TURN_IDLE_STATUSES note).
    const name = statusName(e.properties?.status);
    return name !== undefined && TURN_IDLE_STATUSES.has(name);
  }
  return false;
}

/** A tool-part update for our session: `{ callID, tool, state:{status,…} }` (§1.1). */
export interface ToolUpdate {
  callID: string;
  tool: string;
  status: string;
  title?: string;
  error?: string;
}

export function extractToolUpdate(e: RawEvent, sessionId: string): ToolUpdate | null {
  if (propStr(e.properties, "sessionID") !== sessionId) return null;
  const part = (e.properties?.part ?? e.properties?.tool) as Record<string, unknown> | undefined;
  if (e.type === "message.part.updated" && part && (part.type === "tool" || part.state)) {
    const state = (part.state ?? {}) as Record<string, unknown>;
    return {
      callID: String(part.callID ?? part.id ?? ""),
      tool: String(part.tool ?? "tool"),
      status: String(state.status ?? "running"),
      title: typeof state.title === "string" ? state.title : undefined,
      error: typeof state.error === "string" ? state.error : undefined,
    };
  }
  // session.next.tool.* family.
  if (e.type.startsWith("session.next.tool.")) {
    return {
      callID: propStr(e.properties, "callID") ?? "",
      tool: propStr(e.properties, "tool") ?? "tool",
      status: e.type === "session.next.tool.called" ? "running" : (propStr(e.properties, "status") ?? "running"),
      title: propStr(e.properties, "title"),
    };
  }
  return null;
}

/** A `permission.asked` request for our session (§1.1 — properties IS the PermissionRequest). */
export interface PermissionAsk {
  requestID: string;
  permission: string;
  patterns: string[];
}

export function extractPermissionAsk(e: RawEvent, sessionId: string): PermissionAsk | null {
  if (e.type !== "permission.asked") return null;
  if (propStr(e.properties, "sessionID") !== sessionId) return null;
  const id = propStr(e.properties, "id");
  if (!id) return null;
  const patterns = Array.isArray(e.properties?.patterns)
    ? (e.properties!.patterns as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  return { requestID: id, permission: propStr(e.properties, "permission") ?? "tool", patterns };
}

/** Is this the guardian's synthetic upstream-reset frame for our session? (§3.2 restart handling.) */
export function isSessionError(e: RawEvent, sessionId: string): boolean {
  return e.type === "session.error" && propStr(e.properties, "sessionID") === sessionId;
}
