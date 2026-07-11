/**
 * Markdown renderer for chat messages (review 2026-07-10 §B6 — ported
 * verbatim from `packages/ui/src/lib/markdown.ts` so the client keeps the
 * SAME escaping guarantees as the host chat).
 *
 * `html: false` blocks raw <script>/<iframe>/etc. embedded in assistant
 * responses — the model can return any text, so we treat assistant output
 * as untrusted. `linkify` auto-converts bare URLs to clickable links.
 * `breaks: true` turns single newlines into <br> so chat-style writing
 * (where users routinely don't double-space paragraphs) renders sensibly.
 *
 * Links open in a new tab/window with `noopener noreferrer` so a
 * compromised remote can't reach our window.opener.
 */
import MarkdownIt from 'markdown-it';

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(text: string): string {
  return md.render(text);
}

export function renderMarkdownInline(text: string): string {
  return md.renderInline(text);
}
