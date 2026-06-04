/**
 * API channel streaming renderer (design §4.4, §4.5) — Stage 6.
 *
 * The OpenAI/Anthropic API channel honors `stream: true` by mapping the
 * guardian's filtered native OpenCode /event stream into the protocol the client
 * expects:
 *   - OpenAI: `chat.completion.chunk` / `text_completion` (legacy) SSE frames,
 *     terminated by `data: [DONE]`.
 *   - Anthropic: the `message_start` → `content_block_start` →
 *     `content_block_delta`* → `content_block_stop` → `message_delta` →
 *     `message_stop` SSE sequence.
 *
 * `stream: false` keeps today's buffered JSON (handled in index.ts via the
 * legacy /channel/inbound envelope) — this module is ONLY the streaming path.
 *
 * Like the Discord/Slack renderers, ALL native-OpenCode-event interpretation
 * (text delta correlation, turn-end, permission-ask) is the SAME shared pure
 * logic from `@openpalm/channels-sdk` (oc-events) — no per-channel duplication
 * (§2.2). What lives HERE is the protocol-specific SSE framing and the
 * non-interactive permission policy application (§4.5).
 *
 * Permissions are non-interactive (§4.5): on `permission.asked` the adapter
 * applies the declared policy (default reject; opt-in auto:once with an explicit
 * allowlist) and issues a normal signed, ownership-checked
 * `POST /permission/{requestID}/reply` through the guardian — never bypassing it.
 *
 * The text-delta correlation and turn-end detection are the same security-load-
 * bearing functions every renderer uses, so the protocol framers below are kept
 * pure and unit-tested directly.
 */

import {
  OcClient,
  createLogger,
  asRaw,
  partSnapshotType,
  extractTextDelta,
  isTurnEnd,
  extractPermissionAsk,
  extractQuestionAsk,
  isSessionError,
} from "@openpalm/channels-sdk";
import { decidePermission, type PermissionPolicy } from "./permissions.ts";

const log = createLogger("channel-api:stream");

/** Hard ceiling on a single streamed turn so a stuck stream can't render forever. */
const TURN_RENDER_TIMEOUT_MS = Number(Bun.env.OP_API_TURN_RENDER_TIMEOUT_MS) || 10 * 60_000;

// ── Pure SSE frame framers (unit-tested directly) ──────────────────────────
//
// Each returns ONE SSE frame string (`data: <json>\n\n`). They are pure: given
// the same inputs they emit identical bytes, so the protocol mapping is verified
// without a live OpenCode server.

const created = () => Math.floor(Date.now() / 1000);

/** One `chat.completion.chunk` carrying a content delta (OpenAI streaming). */
export function openAiChunk(id: string, model: string, delta: string): string {
  const frame = {
    id,
    object: "chat.completion.chunk",
    created: created(),
    model,
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/** The first OpenAI chunk announces the assistant role (matches OpenAI's stream). */
export function openAiRoleChunk(id: string, model: string): string {
  const frame = {
    id,
    object: "chat.completion.chunk",
    created: created(),
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/** The terminal OpenAI chunk: empty delta + `finish_reason:"stop"`, then [DONE]. */
export function openAiDoneChunks(id: string, model: string): string {
  const stop = {
    id,
    object: "chat.completion.chunk",
    created: created(),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return `data: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`;
}

/** One legacy `text_completion` streaming chunk. */
export function openAiLegacyChunk(id: string, model: string, delta: string, finish: string | null): string {
  const frame = {
    id,
    object: "text_completion",
    created: created(),
    model,
    choices: [{ text: delta, index: 0, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/** The Anthropic stream preamble: `message_start` + `content_block_start`. */
export function anthropicStart(id: string, model: string): string {
  const messageStart = {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
  const blockStart = {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  };
  return `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`
    + `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`;
}

/** One Anthropic `content_block_delta` (text_delta). */
export function anthropicDelta(delta: string): string {
  const frame = {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: delta },
  };
  return `event: content_block_delta\ndata: ${JSON.stringify(frame)}\n\n`;
}

/** The Anthropic stream terminus: block_stop → message_delta → message_stop. */
export function anthropicStop(): string {
  const blockStop = { type: "content_block_stop", index: 0 };
  const messageDelta = {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 },
  };
  const messageStop = { type: "message_stop" };
  return `event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`
    + `event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`
    + `event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`;
}

// ── Protocol framer interface ──────────────────────────────────────────────
//
// A framer captures the per-protocol opening/delta/closing frames so the single
// turn runner below is protocol-agnostic. Built from the pure framers above.

export interface SseFramer {
  contentType: string;
  /** Frames to emit before any delta (role chunk / message_start). May be "". */
  open(): string;
  /** Frame for one text delta. */
  delta(text: string): string;
  /** Terminal frames ([DONE] / message_stop). */
  close(): string;
}

export function openAiChatFramer(id: string, model: string): SseFramer {
  return {
    contentType: "text/event-stream",
    open: () => openAiRoleChunk(id, model),
    delta: (text) => openAiChunk(id, model, text),
    close: () => openAiDoneChunks(id, model),
  };
}

export function openAiLegacyFramer(id: string, model: string): SseFramer {
  return {
    contentType: "text/event-stream",
    open: () => "",
    delta: (text) => openAiLegacyChunk(id, model, text, null),
    close: () => openAiLegacyChunk(id, model, "", "stop") + "data: [DONE]\n\n",
  };
}

export function anthropicFramer(id: string, model: string): SseFramer {
  return {
    contentType: "text/event-stream",
    open: () => anthropicStart(id, model),
    delta: (text) => anthropicDelta(text),
    close: () => anthropicStop(),
  };
}

// ── The streamed-turn runner ────────────────────────────────────────────────

export interface StreamTurnArgs {
  client: OcClient;
  policy: PermissionPolicy;
  /** Principal userId (e.g. "api:u1") — signs every /oc call. */
  userId: string;
  /** Session key for guardian grouping (e.g. "api:u1"). */
  sessionKey: string;
  /** The user's prompt text. */
  text: string;
  /** Per-protocol SSE framer. */
  framer: SseFramer;
}

/**
 * Drive ONE streamed turn through the guardian /oc proxy and return a
 * `text/event-stream` Response. Mirrors the Discord/Slack turn runners:
 *   - create the session (guardian rewrites the title);
 *   - subscribe to the filtered /event stream BEFORE prompting (§4.2);
 *   - prompt_async with a generated messageID and correlate frames to it;
 *   - emit framer.delta() per text delta until turn-end;
 *   - on `permission.asked`, apply the non-interactive policy (§4.5) and reply
 *     through the guardian (signed, ownership-checked); a rejected tool simply
 *     lets the assistant continue/report — no human prompt is rendered.
 *
 * The ReadableStream tears down the /event subscription when the client
 * disconnects (the request signal aborts the controller).
 */
export function streamTurn(args: StreamTurnArgs, signal?: AbortSignal): Response {
  const { client, policy, userId, sessionKey, text, framer } = args;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (frame: string) => {
        if (frame) controller.enqueue(encoder.encode(frame));
      };

      const ac = new AbortController();
      const onClientAbort = () => ac.abort();
      signal?.addEventListener("abort", onClientAbort, { once: true });

      try {
        const session = await client.createSession(userId, sessionKey);
        const sessionId = session.id;

        // Subscribe BEFORE prompting (§4.2) so no frame is missed.
        const eventsIter = client.events(userId, ac.signal);

        // Fire the turn but DON'T await — /message resolves only at turn-end and
        // the loop drives off /event (prompt_async no-ops on follow-up turns).
        void client.prompt(userId, sessionId, text).catch((err) => {
          log.warn("prompt_failed", { error: String(err), sessionId });
          ac.abort();
        });

        send(framer.open());

        const deadline = Date.now() + TURN_RENDER_TIMEOUT_MS;
        const reasoningParts = new Set<string>(); // partIDs typed "reasoning" → never streamed out
        for await (const ev of eventsIter) {
          if (Date.now() > deadline) {
            log.warn("turn_render_timeout", { sessionId });
            break;
          }
          const e = asRaw(ev);
          const snap = partSnapshotType(e);
          if (snap && snap.type === "reasoning") reasoningParts.add(snap.partID);

          const delta = extractTextDelta(e, sessionId, reasoningParts);
          if (delta) {
            send(framer.delta(delta));
            continue;
          }

          const ask = extractPermissionAsk(e, sessionId);
          if (ask) {
            const reply = decidePermission(policy, ask);
            log.info("permission_decided", { requestID: ask.requestID, permission: ask.permission, reply });
            // Signed, ownership-checked reply through the guardian (§4.5).
            await client.replyPermission(userId, ask.requestID, reply).catch((err) =>
              log.warn("permission_reply_failed", { error: String(err), requestID: ask.requestID }),
            );
            continue;
          }

          const question = extractQuestionAsk(e, sessionId);
          if (question) {
            // Non-interactive channel: no human to answer → reject so the turn
            // doesn't hang. The assistant then proceeds / reports it couldn't ask.
            log.info("question_rejected", { requestID: question.requestID });
            await client.rejectQuestion(userId, question.requestID).catch((err) =>
              log.warn("question_reject_failed", { error: String(err), requestID: question.requestID }),
            );
            continue;
          }

          if (isTurnEnd(e, sessionId)) break;

          if (isSessionError(e, sessionId)) {
            log.warn("session_error", { sessionId });
            break;
          }
        }

        send(framer.close());
        ac.abort();
      } catch (err) {
        log.error("stream_turn_failed", { error: err instanceof Error ? err.message : String(err) });
        // Best-effort: close the protocol stream cleanly so the client isn't hung.
        send(framer.close());
      } finally {
        signal?.removeEventListener("abort", onClientAbort);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": framer.contentType,
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ── Exported pure helpers for unit tests ───────────────────────────────────

export const _internal = {
  openAiChunk,
  openAiRoleChunk,
  openAiDoneChunks,
  openAiLegacyChunk,
  anthropicStart,
  anthropicDelta,
  anthropicStop,
};
