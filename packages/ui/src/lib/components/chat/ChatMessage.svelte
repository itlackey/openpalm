<script lang="ts">
  import { onMount } from 'svelte';
  import type { ChatEntry } from '$lib/types.js';
  import { renderMarkdown } from '$lib/markdown.js';

  interface Props {
    entry: ChatEntry;
  }

  let { entry }: Props = $props();

  const renderedHtml = $derived.by(() => {
    if (entry.type === 'divider' || entry.type === 'note' || entry.type === 'tool-group') return null;
    return entry.role === 'assistant' ? renderMarkdown(entry.text) : null;
  });

  let settled = $state(false);

  onMount(() => {
    if (entry.type !== 'divider' && entry.type !== 'note' && entry.type !== 'tool-group' && entry.role === 'assistant') {
      requestAnimationFrame(() => {
        settled = true;
      });
    }
  });
</script>

{#if entry.type === 'divider'}
  <div class="s-divider" aria-label={entry.label}>
    <span class="s-divider-label">{entry.label}</span>
  </div>
{:else if entry.type === 'note'}
  <div class="s-note" aria-label={entry.label}>
    <span class="s-note-text">{entry.text}</span>
  </div>
{:else if entry.type === 'tool-group'}
  <!-- Orphan tool activity is surfaced in the chat-page tool accordion (ToolLog),
       not inline. Nothing to render in the thread. -->
{:else if entry.role === 'user'}
  <div class="turn you">
    <div class="you-words">{entry.text}</div>
    <div class="mark">You</div>
  </div>
{:else}
  <div class="turn master">
    {#if renderedHtml !== null}
      <div class="master-words" class:settled>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown uses markdown-it with html:false, so raw HTML in assistant output is escaped (not rendered); only generated formatting markup reaches here -->
        <div class="markdown-body">{@html renderedHtml}</div>
      </div>
    {:else}
      <div class="master-words" class:settled>
        <p>{entry.text}</p>
      </div>
    {/if}
    <div class="mark">Assistant</div>
  </div>
{/if}

<style>
  .s-divider {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--s-breath) 0 calc(var(--s-breath) * 0.4);
  }

  .s-divider-label {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .s-note {
    display: flex;
    justify-content: center;
    padding: calc(var(--s-breath) * 0.5) 0;
  }

  .s-note-text {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  /* ── Two-voice treatment ── */

  .turn {
    display: flex;
    flex-direction: column;
  }

  /* The person — small, soft, whispered — sits right */
  .turn.you {
    align-items: flex-end;
    text-align: right;
  }

  .mark {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-mark);
    text-transform: uppercase;
    color: var(--s-ink-3);
    white-space: nowrap;
    margin-top: var(--s-sp-3);
  }

  .you-words {
    font-family: var(--s-font-header);
    font-weight: 300;
    font-size: var(--s-type-whisper);
    line-height: 1.5;
    color: var(--s-ink-2);
    max-width: 80%;
    text-wrap: pretty;
    border-width: 0 0 var(--s-hair);
    border-style: solid;
    border-color: color-mix(in srgb, var(--s-ink) 10%, transparent);
    border-radius: 0 0 10px 0;
    padding: 0 var(--s-sp-4) var(--s-sp-2);
  }

  /* The agent — large, calm, unhurried */
  .turn.master {
    gap: 0.9rem;
  }

  .master-words {
    font-family: var(--s-font-header);
    font-weight: 300;
    font-size: 1.6rem;
    line-height: 1.42;
    letter-spacing: 0.002em;
    color: var(--s-ink);
    text-wrap: pretty;
    max-width: 80%;
    opacity: 0;
    filter: blur(7px);
    transform: translateY(5px);
    transition:
      opacity var(--s-t-bloom) var(--s-ease),
      filter var(--s-t-bloom) var(--s-ease),
      transform var(--s-t-bloom) var(--s-ease);
    border-width: var(--s-hair) 0 3px;
    border-style: solid;
    border-color: color-mix(in srgb, var(--s-ink) 9%, transparent);
    border-radius: 20px;
    padding: var(--s-sp-3) var(--s-sp-4) var(--s-sp-4);
  }

  .master-words.settled {
    opacity: 1;
    filter: blur(0);
    transform: none;
  }

  /* Markdown inside master-words */
  .master-words :global(p) {
    margin: 0 0 0.6rem 0;
  }
  .master-words :global(p:last-child) {
    margin-bottom: 0;
  }
  .master-words :global(ul),
  .master-words :global(ol) {
    margin: 0 0 0.6rem 0;
    padding-left: 1.4rem;
  }
  .master-words :global(li) {
    margin: 0.3rem 0;
    font-size: var(--s-type-whisper);
    color: var(--s-ink-2);
  }
  .master-words :global(code) {
    font-family: var(--s-font-mono);
    font-size: 0.78em;
    color: var(--s-ink-2);
  }
  .master-words :global(pre) {
    margin: 0.7rem 0;
    padding: 0.8rem 1rem;
    border-left: var(--s-hair) solid var(--s-line);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    overflow-x: auto;
    white-space: pre-wrap;
  }
  .master-words :global(pre code) {
    font-size: inherit;
    color: inherit;
  }
  .master-words :global(a) {
    color: var(--s-ink);
    text-decoration: underline;
    text-underline-offset: 0.15em;
    text-decoration-color: var(--s-line);
  }
  .master-words :global(blockquote) {
    margin: 0.6rem 0;
    padding-left: 1rem;
    border-left: var(--s-hair) solid var(--s-seal);
    color: var(--s-ink-2);
  }
  .master-words :global(h1),
  .master-words :global(h2),
  .master-words :global(h3),
  .master-words :global(h4) {
    margin: 0.8rem 0 0.4rem;
    font-family: var(--s-font-header);
    font-weight: 400;
    color: var(--s-ink);
  }
  .master-words :global(hr) {
    margin: 0.8rem 0;
    border: 0;
    border-top: var(--s-hair) solid var(--s-line);
  }

  @media (prefers-reduced-motion: reduce) {
    .master-words {
      transition: opacity 0.4s var(--s-ease);
      filter: none;
      transform: none;
    }
  }
</style>
