<script lang="ts">
  // One chat turn — adapted from packages/ui ChatMessage.svelte (P5b item 3,
  // #555). The client renders assistant text as plain text (pre-wrap) for
  // the thin slice; markdown rendering follows with chat parity.
  import { onMount } from 'svelte';

  interface Props {
    role: 'user' | 'assistant';
    text: string;
  }

  let { role, text }: Props = $props();

  let settled = $state(false);

  onMount(() => {
    if (role === 'assistant') {
      requestAnimationFrame(() => {
        settled = true;
      });
    }
  });
</script>

{#if role === 'user'}
  <div class="turn you">
    <div class="you-words">{text}</div>
    <div class="mark">You</div>
  </div>
{:else}
  <div class="turn master">
    <div class="master-words" class:settled>
      <p>{text}</p>
    </div>
    <div class="mark">Assistant</div>
  </div>
{/if}

<style>
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
    white-space: pre-wrap;
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
    white-space: pre-wrap;
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

  .master-words p {
    margin: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .master-words {
      transition: opacity 0.4s var(--s-ease);
      filter: none;
      transform: none;
    }
  }
</style>
