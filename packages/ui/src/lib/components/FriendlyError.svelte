<script lang="ts">
  import type { FriendlyErrorView } from '$lib/wizard/error-messages.js';

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
    background: #fef3f2;
    border: 1px solid #fecaca;
    border-radius: 8px;
    padding: 12px 14px;
    color: #7f1d1d;
    font-size: var(--text-sm, 0.875rem);
  }
  .friendly-error-header {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #b91c1c;
  }
  .friendly-error-title { font-size: var(--text-sm, 0.875rem); }
  .friendly-error-body {
    margin: 6px 0 0;
    color: #7f1d1d;
  }
  .friendly-error-hint {
    margin: 6px 0 0;
    color: #525252;
    font-size: var(--text-xs, 0.75rem);
  }
  .friendly-error-links {
    margin-top: 8px;
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .friendly-error-link {
    color: #b91c1c;
    text-decoration: underline;
    font-size: var(--text-xs, 0.75rem);
    font-weight: 500;
  }
  .friendly-error-details {
    margin-top: 10px;
    font-size: var(--text-xs, 0.75rem);
  }
  .friendly-error-details summary {
    cursor: pointer;
    color: #525252;
  }
  .friendly-error-details pre {
    margin: 6px 0 0;
    padding: 8px;
    background: #fafafa;
    border: 1px solid #e5e5e5;
    border-radius: 4px;
    /* Bound the height so a long pull/container list scrolls inside the box
       instead of growing the alert past the viewport (clipped + unreadable
       on small screens / when many images are listed). */
    max-height: min(40vh, 320px);
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: #404040;
  }
</style>
