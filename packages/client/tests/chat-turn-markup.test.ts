/**
 * B6/B7 [MEDIUM] (review 2026-07-10) — source "pin" test for ChatTurn.svelte's
 * markdown + copy-affordance wiring, complementing tests/markdown.test.ts
 * and tests/copy.test.ts (packages/client has no component-render harness).
 *
 * RED until ChatTurn.svelte renders assistant text through renderMarkdown()
 * (not `<p>{text}</p>` verbatim) and offers copy affordances.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../src/lib/components/chat/ChatTurn.svelte', import.meta.url));

function source(): string {
  return readFileSync(PATH, 'utf8');
}

describe('ChatTurn.svelte — B6 markdown rendering', () => {
  test('assistant text renders through renderMarkdown via {@html}, not plain <p>{text}</p>', () => {
    const src = source();
    expect(src).toContain("from '$lib/markdown.js'");
    expect(src).toContain('renderMarkdown');
    expect(src).toContain('{@html renderedHtml}');
    expect(src).not.toContain('<p>{entry.text}</p>');
    expect(src).not.toContain('<p>{text}</p>');
  });
});

describe('ChatTurn.svelte — B7 copy affordances', () => {
  test('offers a message-copy button using the pure clipboard module', () => {
    const src = source();
    expect(src).toContain("from '$lib/chat/copy.js'");
    expect(src).toContain('writeClipboardText');
    expect(src).toMatch(/aria-label=\{copied \? 'Copied' : 'Copy message'\}/);
  });

  test('decorates rendered code blocks with a per-block copy button', () => {
    const src = source();
    expect(src).toContain('decorateCodeCopy');
    expect(src).toContain('Copy code');
  });
});
