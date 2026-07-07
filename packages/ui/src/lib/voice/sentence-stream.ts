/**
 * Incremental sentence chunker for streamed TTS. As the assistant reply
 * streams in, the chat layer calls `extractSpeakableChunks` with the whole
 * accumulated buffer plus the offset it has already spoken up to; each
 * returned chunk is a complete sentence (or merged run of short sentences)
 * that can be handed to the speak queue immediately, so audio starts within
 * one sentence of the reply instead of after the full turn.
 *
 * Pure and dependency-free like speakable-text.ts — markdown stripping is
 * NOT done here (playOne applies toSpeakableText per chunk).
 *
 * Known limitations (accepted for v1): abbreviations outside the short
 * guard list below and initials cut early because they look like sentence
 * ends; a decimal split across two deltas ("3." then "14") cuts mid-number
 * when whitespace happens to follow the dot. Both cost a short pause in the
 * audio, never lost text.
 */

/**
 * Chunks shorter than this merge forward into the following sentence — a
 * one-word utterance per TTS request wastes a round trip and sounds choppy.
 */
const MIN_CHUNK_CHARS = 25;

/**
 * Best-effort abbreviation guard: a period straight after one of these
 * tokens is almost never a sentence end ("Dr. Smith", "e.g. this"), so the
 * chunker skips the cut. Deliberately short — a missing abbreviation only
 * costs an early cut (short audio pause), a false positive only merges two
 * sentences into one chunk. Matched case-insensitively.
 */
const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'vs', 'etc', 'e.g', 'i.e', 'approx',
]);

/**
 * Abbreviations matched case-SENSITIVELY: lowercase "no" is an ordinary word
 * that legitimately ends sentences ("the answer is no."), while "No. 5" is
 * the numero abbreviation.
 */
const CASED_ABBREVIATIONS = new Set(['No']);

/**
 * True when the token immediately before the period at `periodIndex` is a
 * known abbreviation. The token is scanned back over letters and interior
 * periods so multi-part abbreviations ("e.g.", "i.e.") match at their final
 * period (their interior periods are never cut candidates — no whitespace
 * follows them).
 */
function endsWithAbbreviation(buffer: string, periodIndex: number): boolean {
  let start = periodIndex;
  while (start > 0 && /[a-zA-Z.]/.test(buffer[start - 1])) start -= 1;
  const token = buffer.slice(start, periodIndex);
  if (!token) return false;
  return ABBREVIATIONS.has(token.toLowerCase()) || CASED_ABBREVIATIONS.has(token);
}

export function extractSpeakableChunks(
  buffer: string,
  offset: number,
): { chunks: string[]; nextOffset: number } {
  const chunks: string[] = [];
  let nextOffset = offset;
  let chunkStart = offset;

  // Fence parity must be tracked from the very start of the buffer —
  // `offset` may sit inside a code block opened before it. O(buffer) per
  // call is fine for chat-reply sizes.
  let inFence = false;
  let i = 0;
  while (i < buffer.length) {
    if (buffer.startsWith('```', i)) {
      inFence = !inFence;
      i += 3;
      continue;
    }
    if (i < offset || inFence) {
      i += 1;
      continue;
    }

    // A boundary is the index AFTER which it is safe to cut: terminal
    // punctuation followed by existing whitespace (so "3.14" and a
    // buffer-final "." — where the next delta could continue the token —
    // never cut), or a double newline. A period right after a known
    // abbreviation is not a boundary either.
    let cut = -1;
    const ch = buffer[i];
    if ((ch === '.' || ch === '!' || ch === '?') && i + 1 < buffer.length && /\s/.test(buffer[i + 1])) {
      if (ch !== '.' || !endsWithAbbreviation(buffer, i)) cut = i + 1;
    } else if (ch === '\n' && buffer[i + 1] === '\n') {
      cut = i + 2;
    }
    if (cut !== -1) {
      const candidate = buffer.slice(chunkStart, cut).trim();
      // Shorter fragments merge forward into the next sentence.
      if (candidate.length >= MIN_CHUNK_CHARS) {
        chunks.push(candidate);
        chunkStart = cut;
        nextOffset = cut;
      }
    }
    i += 1;
  }

  // The incomplete tail past nextOffset stays buffered for the next call.
  return { chunks, nextOffset };
}
