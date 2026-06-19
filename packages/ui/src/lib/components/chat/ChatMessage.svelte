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

  let deedsOpen = $state(false);
  let settled = $state(false);

  function toggleDeeds(): void {
    deedsOpen = !deedsOpen;
  }

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
  <div class="s-deed-group">
    <div class="deeds-inner">
      {#each entry.toolStates as tool}
        <div class="deed">{tool.title}</div>
      {/each}
    </div>
  </div>
{:else if entry.role === 'user'}
  <div class="turn you">
    <div class="you-mark">you</div>
    <div class="you-words">{entry.text}</div>
  </div>
{:else}
  <div class="turn master">
    {#if renderedHtml !== null}
      <div class="master-words" class:settled>
        <div class="markdown-body">{@html renderedHtml}</div>
      </div>
    {:else}
      <div class="master-words" class:settled>
        <p>{entry.text}</p>
      </div>
    {/if}

    {#if entry.toolStates && entry.toolStates.length > 0}
      <div class="seal-row">
        <button
          class="seal"
          type="button"
          aria-expanded={deedsOpen}
          aria-label="What I did"
          onclick={toggleDeeds}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="4" width="18" height="17" rx="2.5" stroke="var(--s-seal)" stroke-width="1.5"/>
            <path d="M7 9h10M7 13h6" stroke="var(--s-seal)" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M15 16l1.5 1.5 2.5-2.5" stroke="var(--s-seal)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <span class="seal-hint">what I did</span>
      </div>

      {#if deedsOpen}
        <div class="deeds open">
          <div class="deeds-inner">
            <div class="deeds-title">what I did</div>
            {#each entry.toolStates as tool}
              <div class="deed">{tool.title}</div>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
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

  .s-deed-group {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: calc(var(--s-breath) * 0.25) 0;
  }

  /* ── Two-voice treatment ── */

  .turn {
    display: flex;
    flex-direction: column;
  }

  /* The person — small, soft, whispered */
  .turn.you {
    gap: 0.5rem;
  }

  .you-mark {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-mark);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .you-words {
    font-family: var(--s-font-display);
    font-weight: 400;
    font-size: var(--s-type-whisper);
    line-height: var(--s-type-whisper-lh);
    color: var(--s-ink-2);
    max-width: var(--s-measure-whisper);
    white-space: pre-wrap;
    border-width: 0 0 1px;
    border-style: solid;
    border-color: color-mix(in srgb, var(--s-ink) 10%, transparent);
    border-radius: 0 0 0 10px;
    padding: 0 5px;
  }

  /* The agent — large, calm, unhurried */
  .turn.master {
    gap: 0.9rem;
  }

  .master-words {
    font-family: var(--s-font-display);
    font-weight: 400;
    font-size: var(--s-type-voice);
    line-height: var(--s-type-voice-lh);
    letter-spacing: 0.002em;
    color: var(--s-ink);
    text-wrap: pretty;
    opacity: 0;
    filter: blur(7px);
    transform: translateY(5px);
    transition:
      opacity var(--s-t-bloom) var(--s-ease),
      filter var(--s-t-bloom) var(--s-ease),
      transform var(--s-t-bloom) var(--s-ease);
    border-width: 1px 0 3px;
    border-style: solid;
    border-color: color-mix(in srgb, var(--s-ink) 9%, transparent);
    border-radius: 20px;
    padding: 5px 5px 10px;
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
    font-family: var(--s-font-display);
    font-weight: 400;
    color: var(--s-ink);
  }
  .master-words :global(hr) {
    margin: 0.8rem 0;
    border: 0;
    border-top: var(--s-hair) solid var(--s-line);
  }

  /* ── Seal + deeds ── */

  .seal-row {
    display: flex;
    align-items: center;
    gap: 0.85rem;
  }

  .seal {
    appearance: none;
    border: 0;
    background: none;
    cursor: pointer;
    padding: 0;
    width: var(--s-glyph-size);
    height: var(--s-glyph-size);
    flex: 0 0 auto;
    opacity: 0.62;
    transition: opacity var(--s-t-quick) var(--s-ease), transform 0.7s var(--s-ease);
  }

  .seal:hover {
    opacity: 1;
    transform: rotate(-4deg);
  }

  .seal svg {
    display: block;
  }

  .seal-hint {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    opacity: 0;
    transition: opacity var(--s-t-quick) var(--s-ease);
  }

  .seal-row:hover .seal-hint {
    opacity: 1;
  }

  .deeds {
    border-left: var(--s-hair) solid var(--s-line);
    margin: 0.2rem 0 0 14px;
    padding: 0.3rem 0 0.3rem 1.1rem;
    animation: s-bloom-in var(--s-t-settle) var(--s-ease-settle) both;
  }

  @keyframes s-bloom-in {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: none; }
  }

  .deeds-title {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: 0.26em;
    text-transform: uppercase;
    color: var(--s-ink-3);
    margin-bottom: 0.7rem;
  }

  .deed {
    font-family: var(--s-font-mono);
    font-weight: 400;
    font-size: var(--s-type-deed);
    line-height: 1.5;
    color: var(--s-ink-2);
    padding-left: 1rem;
    position: relative;
    margin: 0.32rem 0;
    overflow-wrap: break-word;
    word-break: break-all;
  }

  .deed::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0.55em;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--s-seal);
    opacity: 0.85;
  }

  @media (prefers-reduced-motion: reduce) {
    .master-words {
      transition: opacity 0.4s var(--s-ease);
      filter: none;
      transform: none;
    }
  }
</style>
