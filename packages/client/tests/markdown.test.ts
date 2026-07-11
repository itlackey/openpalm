/**
 * B6 [MEDIUM] (review 2026-07-10 §B6) — markdown rendering for assistant
 * replies, ported from `packages/ui/src/lib/markdown.ts` (same markdown-it
 * config, same escaping guarantees). `ChatTurn.svelte:33` currently renders
 * `<p>{text}</p>` verbatim; assistant replies must render through
 * `renderMarkdown()` with `html:false` so untrusted model output can never
 * inject raw HTML/script tags.
 *
 * RED until packages/client/src/lib/markdown.ts exists.
 */
import { describe, expect, test } from 'bun:test';

async function loadMarkdownModule() {
  return import('../src/lib/markdown.ts');
}

describe('renderMarkdown — basic formatting', () => {
  test('renders bold/italic/code as HTML', async () => {
    const { renderMarkdown } = await loadMarkdownModule();
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>');
    expect(renderMarkdown('`code`')).toContain('<code>code</code>');
  });

  test('renders fenced code blocks as <pre><code>', () => {
    return loadMarkdownModule().then(({ renderMarkdown }) => {
      const html = renderMarkdown('```\nconst a = 1;\n```');
      expect(html).toContain('<pre>');
      expect(html).toContain('const a = 1;');
    });
  });

  test('renders lists', async () => {
    const { renderMarkdown } = await loadMarkdownModule();
    const html = renderMarkdown('- one\n- two');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
  });
});

describe('renderMarkdown — html:false escaping guarantee', () => {
  test('raw HTML in the input is escaped, never rendered', async () => {
    const { renderMarkdown } = await loadMarkdownModule();
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('an inline HTML tag is escaped too', async () => {
    const { renderMarkdown } = await loadMarkdownModule();
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('renderMarkdown — linkify + safe link attributes', () => {
  test('bare URLs are auto-linked', async () => {
    const { renderMarkdown } = await loadMarkdownModule();
    const html = renderMarkdown('see https://example.com for details');
    expect(html).toContain('<a href="https://example.com"');
  });

  test('links open in a new tab with noopener noreferrer', async () => {
    const { renderMarkdown } = await loadMarkdownModule();
    const html = renderMarkdown('[click me](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('renderMarkdown — breaks', () => {
  test('a single newline becomes <br> (chat-style writing)', async () => {
    const { renderMarkdown } = await loadMarkdownModule();
    const html = renderMarkdown('line one\nline two');
    expect(html).toContain('<br>');
  });
});

describe('renderMarkdownInline', () => {
  test('renders inline formatting without wrapping <p>', async () => {
    const { renderMarkdownInline } = await loadMarkdownModule();
    const html = renderMarkdownInline('**bold**');
    expect(html).toBe('<strong>bold</strong>');
  });
});
