<script lang="ts">
  import type { ChatEntry } from '$lib/types.js';
  import { renderMarkdown } from '$lib/markdown.js';
  import { formatTime } from '$lib/format-date.js';
  import ToolStrip from '$lib/components/chat/ToolStrip.svelte';

  interface Props {
    entry: ChatEntry;
  }

  let { entry }: Props = $props();

  // User messages are echoed verbatim — they typed it, don't surprise them
  // by reinterpreting punctuation as markdown. Assistant messages get
  // rendered (markdown-it strips raw HTML at the source).
  const renderedHtml = $derived.by(() => {
    if (entry.type === 'divider' || entry.type === 'note' || entry.type === 'tool-group') return null;
    return entry.role === 'assistant' ? renderMarkdown(entry.text) : null;
  });
</script>

{#if entry.type === 'divider'}
  <div class="thread-divider" aria-label={entry.label}>
    <span class="divider-line"></span>
    <span class="divider-label">{entry.label}</span>
    <span class="divider-line"></span>
  </div>
{:else if entry.type === 'note'}
  <div class="thread-note" aria-label={entry.label}>
    <span class="thread-note-label">{entry.label}</span>
    <span class="thread-note-text">{entry.text}</span>
  </div>
{:else if entry.type === 'tool-group'}
  <!-- Orphan tool activity (no following assistant text in the same turn) -->
  <div class="message message-assistant message-tool-group">
    <div class="tool-strip-inline">
      <ToolStrip items={entry.toolStates} ariaLabel="Assistant tool activity" />
    </div>
    <span class="message-meta">Assistant · {formatTime(entry.timestamp)}</span>
  </div>
{:else}
  <div
    class="message"
    class:message-user={entry.role === 'user'}
    class:message-assistant={entry.role === 'assistant'}
  >
    <div class="message-bubble">
      {#if renderedHtml !== null}
        <div class="message-text markdown-body">{@html renderedHtml}</div>
      {:else}
        <p class="message-text">{entry.text}</p>
      {/if}
      {#if entry.role === 'assistant' && entry.toolStates && entry.toolStates.length > 0}
        <ToolStrip
          items={entry.toolStates}
          bordered={true}
          muted={true}
          ariaLabel="Tool activity for this response"
        />
      {/if}
    </div>
    <span class="message-meta">
      {entry.role === 'user' ? 'You' : 'Assistant'}
      · {formatTime(entry.timestamp)}
    </span>
  </div>
{/if}

<style>
  .thread-divider {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) 0;
    color: var(--color-text-tertiary);
    /* font-size var(--text-xs) = 12px — rubric minimum floor, OK for a divider label */
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    /* All-caps divider label: ≤12 chars, ≥0.05em tracking — passes rubric cat 3 */
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .divider-line {
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }

  .divider-label {
    flex-shrink: 0;
    padding: 0 var(--space-2);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
  }

  .thread-note {
    margin: 0 auto;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    background: var(--color-bg-tertiary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    text-align: center;
    color: var(--color-text-secondary);
  }

  .thread-note-label {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-tertiary);
  }

  .thread-note-text {
    font-size: var(--text-xs);
    line-height: 1.4;
  }

  /* Standard chat layout inside the centered conversation column: user turns
     align right, assistant turns align left, each in a bubble capped well under
     the column width so neither hugs the screen edge. */
  /* The row stays centered in the conversation column (sized by the parent
     .messages-area rule). align-items — NOT align-self — moves the bubble to the
     correct side WITHIN the centered row; align-self would shove the whole row
     to a screen edge. */
  .message {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 100%;
    max-width: 100%;
  }

  .message-user {
    align-items: flex-end;
  }

  .message-assistant {
    align-items: flex-start;
  }

  .message-tool-group {
    gap: var(--space-1);
  }

  .message-bubble {
    max-width: 85%;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-lg);
    line-height: var(--leading-normal);
  }

  /* User bubble: charcoal, right-aligned with a tucked corner. Keeps brand
     orange reserved for primary actions. */
  .message-user .message-bubble {
    background: var(--color-chat-user-bubble);
    color: var(--color-chat-user-text);
    border: 1px solid color-mix(in srgb, var(--color-chat-user-bubble) 88%, #fff 12%);
    border-bottom-right-radius: var(--radius-sm);
  }

  /* Assistant bubble: neutral surface, left-aligned with a tucked corner. */
  .message-assistant .message-bubble {
    background: var(--color-bg-tertiary);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-bottom-left-radius: var(--radius-sm);
  }

  .tool-strip-inline {
    max-width: 85%;
    padding: var(--space-1) 0;
  }

  .message-text {
    font-size: var(--text-base);
    word-break: break-word;
  }

  /* User messages: preserve typed whitespace verbatim. */
  .message-user .message-text:not(.markdown-body) {
    white-space: pre-wrap;
  }

  /* Markdown-rendered assistant messages: style the common block-level
     elements emitted by markdown-it. Scoped to .markdown-body so unrelated
     <p>/<ul> on other pages are untouched. */
  .markdown-body :global(p) {
    margin: 0 0 var(--space-2) 0;
  }
  .markdown-body :global(p:last-child) {
    margin-bottom: 0;
  }
  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: 0 0 var(--space-2) 0;
    padding-left: var(--space-5);
  }
  .markdown-body :global(li) {
    margin: var(--space-1) 0;
  }
  .markdown-body :global(li > p) {
    margin: 0;
  }
  .markdown-body :global(code) {
    font-family: var(--font-mono);
    font-size: 0.9em;
    background: var(--color-bg);
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--color-border);
  }
  .markdown-body :global(pre) {
    margin: var(--space-2) 0;
    padding: var(--space-3);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow-x: auto;
    font-size: 0.9em;
  }
  .markdown-body :global(pre code) {
    background: transparent;
    border: 0;
    padding: 0;
  }
  .markdown-body :global(a) {
    color: var(--color-primary);
    text-decoration: underline;
  }
  .markdown-body :global(a:hover) {
    text-decoration: none;
  }
  .markdown-body :global(blockquote) {
    margin: var(--space-2) 0;
    padding-left: var(--space-3);
    border-left: 3px solid var(--color-border);
    color: var(--color-text-secondary);
  }
  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4) {
    margin: var(--space-3) 0 var(--space-2);
    font-weight: var(--font-bold);
    line-height: var(--leading-tight, 1.25);
  }
  .markdown-body :global(h1) { font-size: 1.4em; }
  .markdown-body :global(h2) { font-size: 1.25em; }
  .markdown-body :global(h3) { font-size: 1.1em; }
  .markdown-body :global(h4) { font-size: 1em; }
  .markdown-body :global(hr) {
    margin: var(--space-3) 0;
    border: 0;
    border-top: 1px solid var(--color-border);
  }
  .markdown-body :global(table) {
    border-collapse: collapse;
    margin: var(--space-2) 0;
    font-size: 0.9em;
  }
  .markdown-body :global(th),
  .markdown-body :global(td) {
    border: 1px solid var(--color-border);
    padding: var(--space-1) var(--space-2);
    text-align: left;
  }

  .message-meta {
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
</style>
