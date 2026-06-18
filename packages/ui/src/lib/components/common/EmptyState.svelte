<script lang="ts">
  // Centered empty/placeholder state: optional icon, message body, optional
  // action. Replaces the repeated `<div class="empty-state">` + icon SVG + <p>
  // pattern. Self-contained scoped style (mirrors the global .empty-state).
  import type { Snippet } from 'svelte';

  interface Props {
    /** Icon markup (typically an inline SVG). */
    icon?: Snippet;
    /** Message body (paragraphs, hints, etc.). */
    children: Snippet;
    /** Optional action(s) — buttons/links shown below the message. */
    action?: Snippet;
  }

  let { icon, children, action }: Props = $props();
</script>

<div class="empty-state">
  {#if icon}{@render icon()}{/if}
  {@render children()}
  {#if action}{@render action()}{/if}
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-sp-3);
    padding: var(--s-sp-8) var(--s-sp-6);
    text-align: center;
    color: var(--s-ink-3);
    font-family: var(--s-font-display);
    font-size: var(--s-type-whisper);
  }

  .empty-state :global(p) {
    font-family: var(--s-font-display);
    font-size: var(--s-type-whisper);
    color: var(--s-ink-3);
  }
</style>
