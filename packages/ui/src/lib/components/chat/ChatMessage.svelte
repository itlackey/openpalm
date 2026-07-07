<script lang="ts">
  import { onMount } from 'svelte';
  import type { ChatEntry } from '$lib/types.js';
  import { renderMarkdown } from '$lib/markdown.js';
  import IconCopy from '$lib/components/icons/IconCopy.svelte';
  import IconDone from '$lib/components/icons/IconDone.svelte';

  interface Props {
    entry: ChatEntry;
  }

  let { entry }: Props = $props();

  const renderedHtml = $derived.by(() => {
    if (entry.type === 'divider' || entry.type === 'note' || entry.type === 'tool-group') return null;
    return entry.role === 'assistant' ? renderMarkdown(entry.text) : null;
  });

  let settled = $state(false);

  /* Copy affordances render only when the Clipboard API exists (checked once on mount). */
  let clipboardAvailable = $state(false);
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    clipboardAvailable =
      typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
    if (entry.type !== 'divider' && entry.type !== 'note' && entry.type !== 'tool-group' && entry.role === 'assistant') {
      requestAnimationFrame(() => {
        settled = true;
      });
    }
    return () => {
      if (copiedTimer !== undefined) clearTimeout(copiedTimer);
    };
  });

  async function copyMessage() {
    if (entry.type === 'divider' || entry.type === 'tool-group') return;
    try {
      await navigator.clipboard.writeText(entry.text);
    } catch {
      // Clipboard write denied — keep the label as-is rather than claim success.
      return;
    }
    copied = true;
    if (copiedTimer !== undefined) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied = false;
    }, 1500);
  }

  /* Inline SVG for buttons created outside the Svelte template (mirrors IconCopy.svelte). */
  const COPY_SVG =
    '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><rect fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" x="9" y="9" width="11" height="11" rx="2"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>';

  /** Appends a copy button to each <pre>. Rendered markdown is static per
   *  message, so a one-time pass at mount suffices — no observer needed. */
  function decorateCodeCopy(node: HTMLElement) {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const pre of node.querySelectorAll('pre')) {
      // Capture before appending the button so the copied text stays clean.
      const text = pre.textContent ?? '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy';
      btn.setAttribute('aria-label', 'Copy code');
      btn.title = 'Copy code';
      btn.innerHTML = COPY_SVG;
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          return;
        }
        btn.setAttribute('aria-label', 'Copied');
        btn.title = 'Copied';
        btn.classList.add('is-copied');
        timers.push(
          setTimeout(() => {
            btn.setAttribute('aria-label', 'Copy code');
            btn.title = 'Copy code';
            btn.classList.remove('is-copied');
          }, 1500)
        );
      });
      pre.appendChild(btn);
    }
    return {
      destroy() {
        for (const t of timers) clearTimeout(t);
      },
    };
  }
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
        <div class="markdown-body" use:decorateCodeCopy>{@html renderedHtml}</div>
      </div>
    {:else}
      <div class="master-words" class:settled>
        <p>{entry.text}</p>
      </div>
    {/if}
    <div class="mark-row">
      <div class="mark">Assistant</div>
      {#if clipboardAvailable}
        <button
          type="button"
          class="msg-copy"
          class:is-copied={copied}
          aria-label={copied ? 'Copied' : 'Copy message'}
          title={copied ? 'Copied' : 'Copy message'}
          onclick={copyMessage}
        >
          {#if copied}
            <IconDone size={14} />
          {:else}
            <IconCopy size={14} />
          {/if}
        </button>
      {/if}
    </div>
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
    position: relative;
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

  /* ── Copy affordances ── */

  .mark-row {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    margin-top: var(--s-sp-3);
  }

  .mark-row .mark {
    margin-top: 0;
  }

  .msg-copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.15rem;
    border: 0;
    background: none;
    color: var(--s-ink-3);
    cursor: pointer;
    border-radius: var(--s-radius-focus);
    transition:
      color var(--s-t-instant) var(--s-ease),
      opacity var(--s-t-instant) var(--s-ease);
  }

  .msg-copy:hover,
  .msg-copy:focus-visible {
    color: var(--s-ink);
  }

  .msg-copy.is-copied {
    color: var(--s-seal);
  }

  /* Quiet until the turn is hovered or holds focus; touch devices always show it. */
  @media (hover: hover) {
    .msg-copy {
      opacity: 0;
    }
    .turn.master:hover .msg-copy,
    .turn.master:focus-within .msg-copy {
      opacity: 1;
    }
  }

  /* Code-block copy buttons are appended by decorateCodeCopy, outside the
     Svelte template — style through :global under the scoped ancestor. */
  .master-words :global(.code-copy) {
    position: absolute;
    top: var(--s-sp-2);
    right: var(--s-sp-2);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
    border: var(--s-hair) solid var(--s-line);
    border-radius: var(--s-radius-focus);
    background: var(--s-paper);
    color: var(--s-ink-3);
    cursor: pointer;
    transition:
      color var(--s-t-instant) var(--s-ease),
      opacity var(--s-t-instant) var(--s-ease);
  }

  .master-words :global(.code-copy:hover),
  .master-words :global(.code-copy:focus-visible) {
    color: var(--s-ink);
  }

  .master-words :global(.code-copy.is-copied) {
    color: var(--s-seal);
  }

  @media (hover: hover) {
    .master-words :global(.code-copy) {
      opacity: 0;
    }
    .master-words :global(pre:hover .code-copy),
    .master-words :global(pre:focus-within .code-copy) {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .master-words {
      transition: opacity 0.4s var(--s-ease);
      filter: none;
      transform: none;
    }
  }
</style>
