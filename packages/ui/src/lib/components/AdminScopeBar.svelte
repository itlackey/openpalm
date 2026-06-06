<script lang="ts">
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  // Makes the scope of the admin area unambiguous: it always administers the
  // LOCAL OpenPalm on THIS host — never the remote assistant the user may be
  // chatting with. The highest-severity clarity fix from the design debate.
  const active = $derived(endpointsService.active);

  // A chat endpoint is "remote" when it isn't loopback. Best-effort host parse.
  const remote = $derived.by(() => {
    const url = active?.url ?? '';
    if (!url) return null;
    try {
      const host = new URL(url).hostname;
      const isLocal =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === 'host.docker.internal';
      return isLocal ? null : (active?.label ?? host);
    } catch {
      return null;
    }
  });
</script>

<div class="scope-bar" class:scope-bar--remote={remote}>
  <span class="scope-main">
    <svg class="scope-icon" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
    <span class="scope-text">
      Managing <strong>this OpenPalm</strong> on this machine <span class="scope-local">(local)</span>
    </span>
  </span>
  {#if remote}
    <span class="scope-remote" title="You're chatting with a remote assistant. Its settings are managed on that machine.">
      Chatting with <strong>{remote}</strong> (remote) — managed there, not here
    </span>
  {/if}
</div>

<style>
  .scope-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    padding: var(--space-2) var(--space-5);
    margin-bottom: var(--space-5);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  /* When a remote chat is active, raise the contrast of the scope bar so the
     "you are NOT editing the remote" message can't be missed. */
  .scope-bar--remote {
    background: var(--color-warning-bg);
    border-color: var(--color-warning);
  }
  .scope-main {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .scope-icon {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }
  .scope-text strong {
    color: var(--color-text);
    font-weight: var(--font-semibold);
  }
  .scope-local {
    color: var(--color-badge-neutral-fg);
    font-weight: var(--font-semibold);
  }
  .scope-remote {
    color: var(--color-badge-warning-fg);
    font-weight: var(--font-medium);
  }
  .scope-remote strong {
    font-weight: var(--font-semibold);
  }
</style>
