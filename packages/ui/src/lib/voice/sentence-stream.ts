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
 * Known limitations (accepted for v1): abbreviations ("Dr. Smith",
 * "e.g. this") and initials cut early because they look like sentence ends;
 * a decimal split across two deltas ("3." then "14") cuts mid-number when
 * whitespace happens to follow the dot. Both cost a short pause in the
 * audio, never lost text.
 */

/**
 * Chunks shorter than this merge forward into the following sentence — a
 * one-word utterance per TTS request wastes a round trip and sounds choppy.
 */
const MIN_CHUNK_CHARS = 25;

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
    // never cut), or a double newline.
    let cut = -1;
    const ch = buffer[i];
    if ((ch === '.' || ch === '!' || ch === '?') && i + 1 < buffer.length && /\s/.test(buffer[i + 1])) {
      cut = i + 1;
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
