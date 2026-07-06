import { describe, expect, test } from 'vitest';
import { extractSpeakableChunks } from './sentence-stream.js';

describe('extractSpeakableChunks', () => {
  test('cuts a complete sentence at terminal punctuation followed by whitespace', () => {
    const buffer = 'The first sentence arrives now. And a tail';
    const { chunks, nextOffset } = extractSpeakableChunks(buffer, 0);
    expect(chunks).toEqual(['The first sentence arrives now.']);
    expect(buffer.slice(nextOffset).trim()).toBe('And a tail');
  });

  test('does not cut inside decimals', () => {
    const { chunks } = extractSpeakableChunks(
      'The value of pi is close to 3.14159 and that is well known. ',
      0,
    );
    expect(chunks).toEqual(['The value of pi is close to 3.14159 and that is well known.']);
  });

  test('does not cut at punctuation that ends the buffer — the next delta may continue it', () => {
    // "3." at the buffer tip could be the start of "3.14" in the next delta.
    expect(extractSpeakableChunks('The answer so far is exactly 3.', 0)).toEqual({
      chunks: [],
      nextOffset: 0,
    });
  });

  test('never cuts inside a fenced code block', () => {
    const buffer = 'Look at this example of code. ```\nconst x = 1. 5;\nmore. lines\n``` tail';
    const { chunks, nextOffset } = extractSpeakableChunks(buffer, 0);
    expect(chunks).toEqual(['Look at this example of code.']);

    // Once a sentence completes after the closing fence, the whole fence
    // rides along in that chunk (playOne strips it to "Code omitted.").
    const grown = `${buffer} and now it ends properly here. `;
    const next = extractSpeakableChunks(grown, nextOffset);
    expect(next.chunks).toEqual([
      '```\nconst x = 1. 5;\nmore. lines\n``` tail and now it ends properly here.',
    ]);
  });

  test('merges short fragments forward until the minimum chunk size', () => {
    const { chunks } = extractSpeakableChunks('Hi. Yes. This makes the chunk long enough now. ', 0);
    expect(chunks).toEqual(['Hi. Yes. This makes the chunk long enough now.']);
  });

  test('a short trailing fragment stays buffered for the next call', () => {
    const buffer = 'A complete first sentence goes right here. Ok. ';
    const { chunks, nextOffset } = extractSpeakableChunks(buffer, 0);
    expect(chunks).toEqual(['A complete first sentence goes right here.']);
    expect(buffer.slice(nextOffset).trim()).toBe('Ok.');
  });

  test('cuts at double newlines even without terminal punctuation', () => {
    const { chunks } = extractSpeakableChunks(
      'First paragraph without punctuation end\n\nSecond paragraph continues',
      0,
    );
    expect(chunks).toEqual(['First paragraph without punctuation end']);
  });

  test('repeated incremental calls only return new chunks', () => {
    let buffer = 'The first sentence arrives now. ';
    const first = extractSpeakableChunks(buffer, 0);
    expect(first.chunks).toEqual(['The first sentence arrives now.']);

    buffer += 'And the second sentence lands afterwards. ';
    const second = extractSpeakableChunks(buffer, first.nextOffset);
    expect(second.chunks).toEqual(['And the second sentence lands afterwards.']);

    // No new boundary since the last call — nothing to speak yet.
    const third = extractSpeakableChunks(buffer, second.nextOffset);
    expect(third).toEqual({ chunks: [], nextOffset: second.nextOffset });
  });

  test('does not cut after a title abbreviation mid-sentence', () => {
    // Without the guard this cut after "Dr." — the fragment before it is
    // past MIN_CHUNK_CHARS, so the short-fragment merge would not save it.
    const { chunks } = extractSpeakableChunks(
      'The patient finally saw Dr. Smith about it yesterday. And a tail',
      0,
    );
    expect(chunks).toEqual(['The patient finally saw Dr. Smith about it yesterday.']);
  });

  test('does not cut at the final period of a multi-part abbreviation', () => {
    const { chunks } = extractSpeakableChunks(
      'There are several good options here, e.g. the blue one works fine. ',
      0,
    );
    expect(chunks).toEqual(['There are several good options here, e.g. the blue one works fine.']);
  });

  test('the numero abbreviation is case-sensitive — "No." holds, "no." cuts', () => {
    const held = extractSpeakableChunks(
      'The winning entry was listed as No. 5 in the official catalog. ',
      0,
    );
    expect(held.chunks).toEqual(['The winning entry was listed as No. 5 in the official catalog.']);

    // Lowercase "no" is an ordinary word that really ends the sentence.
    const cutBuffer = 'The final answer to that question is no. Moving on';
    const cut = extractSpeakableChunks(cutBuffer, 0);
    expect(cut.chunks).toEqual(['The final answer to that question is no.']);
    expect(cutBuffer.slice(cut.nextOffset).trim()).toBe('Moving on');
  });

  test('the abbreviation guard does not suppress a real sentence end', () => {
    // "doctor" ends with the same letters as no abbreviation in the list —
    // whole-token matching must let this genuine boundary cut.
    const buffer = 'I finally saw the doctor today. He waved back at me from across the room. ';
    const { chunks } = extractSpeakableChunks(buffer, 0);
    expect(chunks).toEqual([
      'I finally saw the doctor today.',
      'He waved back at me from across the room.',
    ]);
  });

  test('empty and boundary-free buffers are no-ops', () => {
    expect(extractSpeakableChunks('', 0)).toEqual({ chunks: [], nextOffset: 0 });
    expect(extractSpeakableChunks('no terminal punctuation yet', 0)).toEqual({
      chunks: [],
      nextOffset: 0,
    });
    expect(extractSpeakableChunks('done already. ', 14)).toEqual({ chunks: [], nextOffset: 14 });
  });
});
