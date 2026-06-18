<script lang="ts">
  import type { FriendlyErrorView } from '$lib/client/error-messages.js';

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
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
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
        {#each error.links as link}
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
