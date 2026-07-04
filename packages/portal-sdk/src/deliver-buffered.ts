/**
 * `deliverBufferedAnswer` — the shared buffered-turn delivery block.
 *
 * Every buffered (non-streaming) turn in both portals runs the SAME sequence
 * after a turn is forwarded to the guardian: forward → throw on a non-ok
 * response → read `{ answer = "No response received." }` from the JSON body →
 * split the answer to the platform cap → deliver the first chunk → post the
 * remaining chunks as follow-ups → on any failure post a single `Error: …`.
 *
 * That block was copy-pasted across five sites (three in Slack, two in
 * Discord). It lives here now, driven by a minimal caller-supplied
 * {@link DeliverySink}: `postChunk` posts a follow-up message; the optional
 * `editChunk` edits an already-posted placeholder in place (Slack posts a
 * `:hourglass:` message then `chat.update`s it; Discord's `editReply`). When a
 * sink omits `editChunk` the first chunk and any error are posted instead —
 * exactly matching the post-only sites.
 */
import { splitMessage } from './runtime.ts';

/**
 * The platform hooks `deliverBufferedAnswer` drives. `postChunk` always posts a
 * NEW message; `editChunk`, when present, edits the placeholder for the first
 * chunk (and for the error) in place. Return values are ignored.
 */
export interface DeliverySink {
  postChunk(text: string): Promise<unknown>;
  editChunk?(text: string): Promise<unknown>;
}

export interface DeliverBufferedAnswerOptions {
  /** Forward the turn to the guardian and return the raw response. */
  forward: () => Promise<Response>;
  /** Platform delivery hooks. */
  sink: DeliverySink;
  /** Platform hard message-length cap used to split the answer. */
  maxLength: number;
  /** Optional delay (ms) applied after each chunk when there is more than one. */
  interChunkDelayMs?: number;
  /** Fallback text when the answer is missing/empty (default "No response received."). */
  sentinel?: string;
  /**
   * Fired once the forward has settled (answer parsed OR an error thrown),
   * before delivery. Used by portals that must stop a typing indicator. Expected
   * to be idempotent — it may fire again if delivery itself throws.
   */
  onSettled?: () => void | Promise<void>;
}

export type DeliverBufferedAnswerResult =
  | { ok: true; answer: string; chunks: string[] }
  | { ok: false; error: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one buffered turn to completion against a {@link DeliverySink}. Never
 * throws: a forward failure (rejected promise or non-ok response) is caught,
 * surfaced as a single `Error: …` delivery, and returned as `{ ok: false }`.
 */
export async function deliverBufferedAnswer(
  opts: DeliverBufferedAnswerOptions,
): Promise<DeliverBufferedAnswerResult> {
  const { forward, sink, maxLength, interChunkDelayMs, onSettled } = opts;
  const sentinel = opts.sentinel ?? 'No response received.';

  try {
    const resp = await forward();
    if (!resp.ok) throw new Error(`Guardian returned status ${resp.status}`);
    const { answer = sentinel } = (await resp.json()) as { answer?: string };
    await onSettled?.();

    const chunks = splitMessage(answer, maxLength);
    const firstChunk = chunks[0] ?? sentinel;
    const delay = interChunkDelayMs && interChunkDelayMs > 0 && chunks.length > 1 ? interChunkDelayMs : 0;

    if (sink.editChunk) await sink.editChunk(firstChunk);
    else await sink.postChunk(firstChunk);
    if (delay) await sleep(delay);

    for (let i = 1; i < chunks.length; i++) {
      await sink.postChunk(chunks[i]);
      if (delay) await sleep(delay);
    }

    return { ok: true, answer, chunks };
  } catch (error) {
    await onSettled?.();
    const errMsg = error instanceof Error ? error.message : String(error);
    if (sink.editChunk) await sink.editChunk(`Error: ${errMsg}`);
    else await sink.postChunk(`Error: ${errMsg}`);
    return { ok: false, error: errMsg };
  }
}
