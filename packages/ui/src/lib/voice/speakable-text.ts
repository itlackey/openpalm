/**
 * Deterministic markdown-to-speech text stripping. Pure and dependency-free
 * so both the browser TTS fallback (audio-playback.ts) and the server TTS
 * route (routes/api/speak/+server.ts) can run the exact same rules without
 * ever handing raw markdown syntax to a speech engine.
 *
 * Order matters: fenced code blocks and inline code are handled before any
 * other markdown stripping so their contents are never mistaken for
 * headings/emphasis/list markers. Whitespace collapsing runs last.
 */

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (match) => HTML_ENTITIES[match] ?? match);
}

function urlToHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function toSpeakableText(text: string): string {
  let out = text;

  // Fenced code blocks -> a short spoken placeholder. Must run before
  // inline-code/emphasis stripping so code contents never leak through.
  out = out.replace(/```[\s\S]*?```/g, ' Code omitted. ');

  // Inline code spans -> keep the inner text, drop the backticks.
  out = out.replace(/`([^`]+)`/g, '$1');

  // Images: ![alt](url) -> alt text.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links: [label](url) -> label.
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Bare/auto http(s) URLs -> hostname only.
  out = out.replace(/https?:\/\/[^\s)<>"']+/g, (match) => urlToHostname(match));

  // Raw HTML tags stripped before line-oriented markdown rules so a tag
  // straddling a line boundary doesn't survive as literal angle brackets.
  out = out.replace(/<[^>]+>/g, '');

  // Horizontal rules on their own line.
  out = out.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '');

  // Table separator rows (e.g. "|---|:--:|") carry no speakable content and
  // are dropped entirely (not just emptied) so they don't leave a stray
  // blank line behind after the join.
  const keptLines: string[] = [];
  for (const line of out.split('\n')) {
    let l = line;

    const isTableSeparator = /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-') && l.includes('|');
    if (isTableSeparator) continue;

    // Blockquote markers.
    l = l.replace(/^\s*>\s?/, '');

    // Headings: leading # markers.
    l = l.replace(/^\s*#{1,6}\s+/, '');

    // List markers: -, *, +, or "1." at line start.
    const wasListItem = /^\s*(?:[-*+]|\d+\.)\s+/.test(l);
    l = l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');

    // Table rows: convert remaining cell pipes to ", " (after trimming
    // leading/trailing pipes so we don't emit a leading/trailing separator).
    if (l.includes('|')) {
      l = l
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((cell) => cell.trim())
        .join(', ');
    }

    l = l.trim();

    // Ensure list items end with sentence punctuation so TTS pauses
    // between them instead of running them together.
    if (wasListItem && l && !/[.!?:]$/.test(l)) {
      l += '.';
    }

    keptLines.push(l);
  }
  out = keptLines.join('\n');

  // Emphasis/strikethrough markers — strip the markup, keep the content.
  // Order: strikethrough and bold (double-char) before single-char italics
  // so "**bold**" doesn't leave stray single asterisks behind.
  out = out.replace(/~~(.+?)~~/g, '$1');
  out = out.replace(/\*\*(.+?)\*\*/g, '$1');
  out = out.replace(/__(.+?)__/g, '$1');
  out = out.replace(/\*(.+?)\*/g, '$1');
  out = out.replace(/(?<![A-Za-z0-9_])_(.+?)_(?![A-Za-z0-9_])/g, '$1');

  out = decodeEntities(out);

  // Collapse 3+ newlines to 2 (paragraph break), repeated spaces to one.
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out.replace(/[^\S\n]{2,}/g, ' ');

  return out.trim();
}
