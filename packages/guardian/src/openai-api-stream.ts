import { createLogger } from './logger.ts';
import { readPositiveIntEnv } from './config.ts';
import type { OcClient } from './openai-api-oc-client.ts';
import {
  extractPermissionAsk,
  extractQuestionAsk,
  isSessionError,
  runTurn,
  type TurnEventAction,
} from './openai-api-oc-events.ts';
import { decidePermission, type PermissionPolicy } from './openai-api-permissions.ts';

const log = createLogger('guardian:openai-api:stream');
const TURN_RENDER_TIMEOUT_MS = readPositiveIntEnv('OP_API_TURN_RENDER_TIMEOUT_MS', 10 * 60_000);
const created = () => Math.floor(Date.now() / 1000);

export function openAiChunk(id: string, model: string, delta: string): string {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: created(), model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`;
}

export function openAiRoleChunk(id: string, model: string): string {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: created(), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`;
}

export function openAiDoneChunks(id: string, model: string): string {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: created(), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
}

export function openAiLegacyChunk(id: string, model: string, delta: string, finish: string | null): string {
  return `data: ${JSON.stringify({ id, object: 'text_completion', created: created(), model, choices: [{ text: delta, index: 0, finish_reason: finish }] })}\n\n`;
}

export function anthropicStart(id: string, model: string): string {
  const messageStart = {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  };
  const blockStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  return `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n` + `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`;
}

export function anthropicDelta(delta: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } })}\n\n`;
}

export function anthropicStop(): string {
  return `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`
    + `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`
    + `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
}

export interface SseFramer {
  contentType: string;
  open(): string;
  delta(text: string): string;
  close(): string;
}

export function openAiChatFramer(id: string, model: string): SseFramer {
  return { contentType: 'text/event-stream', open: () => openAiRoleChunk(id, model), delta: (text) => openAiChunk(id, model, text), close: () => openAiDoneChunks(id, model) };
}

export function openAiLegacyFramer(id: string, model: string): SseFramer {
  return { contentType: 'text/event-stream', open: () => '', delta: (text) => openAiLegacyChunk(id, model, text, null), close: () => `${openAiLegacyChunk(id, model, '', 'stop')}data: [DONE]\n\n` };
}

export function anthropicFramer(id: string, model: string): SseFramer {
  return { contentType: 'text/event-stream', open: () => anthropicStart(id, model), delta: (text) => anthropicDelta(text), close: () => anthropicStop() };
}

export interface StreamTurnArgs {
  client: OcClient;
  policy: PermissionPolicy;
  userId: string;
  sessionKey: string;
  text: string;
  framer: SseFramer;
}

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
      signal?.addEventListener('abort', onClientAbort, { once: true });

      try {
        const session = await client.createSession(userId, sessionKey);
        const sessionId = session.id;
        const eventsIter = client.events(userId, ac.signal);
        void client.prompt(userId, sessionId, text).catch((err) => {
          log.warn('prompt_failed', { error: String(err), sessionId });
          ac.abort();
        });

        send(framer.open());
        const deadline = Date.now() + TURN_RENDER_TIMEOUT_MS;
        // Streaming path: supply the full set of security handlers. `runTurn`
        // owns the shared skeleton (reasoning bookkeeping, delta extraction,
        // turn-end); these injected handlers add render-timeout enforcement,
        // permission-policy application, question rejection, and session-error
        // termination — none of which the non-streaming path performs.
        await runTurn(eventsIter, sessionId, {
          shouldStop: () => {
            if (Date.now() > deadline) {
              log.warn('turn_render_timeout', { sessionId });
              return true;
            }
            return false;
          },
          onDelta: (delta) => send(framer.delta(delta)),
          onNonDelta: async (raw): Promise<TurnEventAction> => {
            const permissionAsk = extractPermissionAsk(raw, sessionId);
            if (permissionAsk) {
              const reply = decidePermission(policy, permissionAsk);
              log.info('permission_decided', { requestID: permissionAsk.requestID, permission: permissionAsk.permission, reply });
              await client.replyPermission(userId, permissionAsk.requestID, reply).catch((err) => log.warn('permission_reply_failed', { error: String(err), requestID: permissionAsk.requestID }));
              return 'continue';
            }

            const questionAsk = extractQuestionAsk(raw, sessionId);
            if (questionAsk) {
              log.info('question_rejected', { requestID: questionAsk.requestID });
              await client.rejectQuestion(userId, questionAsk.requestID).catch((err) => log.warn('question_reject_failed', { error: String(err), requestID: questionAsk.requestID }));
              return 'continue';
            }

            if (isSessionError(raw, sessionId)) {
              log.warn('session_error', { sessionId });
              return 'break';
            }
            return 'pass';
          },
        });

        send(framer.close());
        ac.abort();
      } catch (err) {
        log.error('stream_turn_failed', { error: err instanceof Error ? err.message : String(err) });
        send(framer.close());
      } finally {
        signal?.removeEventListener('abort', onClientAbort);
        controller.close();
      }
    },
  });

  return new Response(stream, { status: 200, headers: { 'content-type': framer.contentType, 'cache-control': 'no-cache', connection: 'keep-alive' } });
}

export const _internal = {
  openAiChunk,
  openAiRoleChunk,
  openAiDoneChunks,
  openAiLegacyChunk,
  anthropicStart,
  anthropicDelta,
  anthropicStop,
};
