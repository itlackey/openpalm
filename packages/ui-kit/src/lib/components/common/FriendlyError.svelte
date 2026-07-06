<script lang="ts">
  import type { FriendlyErrorView } from '$lib/client/error-messages.js';
  import IconAlert from '../icons/IconAlert.svelte';

  interface Props {
    error: FriendlyErrorView | null | undefined;
    role?: 'alert' | 'status';
    /** Render compactly without the technical-details disclosure (inline forms). */
    compact?: boolean;
  }

  let { error, role = 'alert', compact = false }: Props = $props();
</script>

{#if error}
  <div class="friendly-error" {role}>
    <div class="friendly-error-header">
      <IconAlert size={18} />
      <strong class="friendly-error-title">{error.title}</strong>
    </div>
    {#if error.body}
      <p class="friendly-error-body">{error.body}</p>
    {/if}
    {#if error.hint}
      <p class="friendly-error-hint">{error.hint}</p>
    {/if}
    {#if error.links && error.links.length > 0}
      <div class="friendly-error-links">
        {#each error.links as link (link.href)}
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
          <a href={link.href} target="_blank" rel="noopener noreferrer" class="friendly-error-link">
            {link.label} →
          </a>
        {/each}
      </div>
    {/if}
    {#if !compact && error.raw && error.raw !== error.body}
      <details class="friendly-error-details">
        <summary>Technical details</summary>
        <pre>{error.raw}</pre>
      </details>
    {/if}
  </div>
{/if}

<style>
  .friendly-error {
    background: color-mix(in srgb, var(--s-seal) 6%, var(--s-paper));
    border: var(--s-hair) solid color-mix(in srgb, var(--s-seal) 20%, transparent);
    border-radius: 2px;
    padding: var(--s-sp-4) var(--s-sp-4);
    color: var(--s-seal);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
  }
  .friendly-error-header {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    color: var(--s-seal);
  }
  .friendly-error-title {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
  }
  .friendly-error-body {
    margin: var(--s-sp-2) 0 0;
    color: var(--s-seal);
  }
  .friendly-error-hint {
    margin: var(--s-sp-2) 0 0;
    color: var(--s-ink-3);
    font-size: var(--s-type-mark-sm);
  }
  .friendly-error-links {
    margin-top: var(--s-sp-2);
    display: flex;
    gap: var(--s-sp-4);
    flex-wrap: wrap;
  }
  .friendly-error-link {
    color: var(--s-seal);
    text-decoration: underline;
    font-size: var(--s-type-mark-sm);
  }
  .friendly-error-details {
    margin-top: var(--s-sp-3);
    font-size: var(--s-type-mark-sm);
  }
  .friendly-error-details summary {
    cursor: pointer;
    color: var(--s-ink-3);
  }
  .friendly-error-details pre {
    margin: var(--s-sp-2) 0 0;
    padding: var(--s-sp-3);
    background: var(--s-paper-deep);
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 2px;
    /* Bound the height so a long pull/container list scrolls inside the box
       instead of growing the alert past the viewport (clipped + unreadable
       on small screens / when many images are listed). */
    max-height: min(40vh, 320px);
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--s-ink-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    text-transform: none;
    letter-spacing: 0;
  }
</style>
