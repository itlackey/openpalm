<script lang="ts">
  /**
   * Global toast renderer — bottom-right stack of transient notifications.
   *
   * Mounted once in the root layout. Reads from the `notifications`
   * singleton ($lib/notifications.svelte.ts — an app-provided, client-only
   * queue with no server assumptions); any code can push toasts without
   * owning a component. Error surfaces that live outside the queue are
   * mirrored INTO it by app code (e.g. packages/ui's root layout mirrors
   * `voiceState.errorMessage`) — never from here: this component must stay
   * presentational, with no reach into app subsystems that carry server
   * assumptions (plan ui-runtime-modes-plan.md §6.11).
   */
  import { notifications, type Toast } from '$lib/notifications.svelte.js';
  import IconDone from '../icons/IconDone.svelte';
  import IconInfo from '../icons/IconInfo.svelte';

  function dismiss(t: Toast): void {
    notifications.dismiss(t.id);
  }

  function kindLabel(t: Toast): string {
    if (t.kind === 'success') return 'Success';
    if (t.kind === 'error') return 'Error';
    return 'Notice';
  }
</script>

{#if notifications.toasts.length > 0}
  <div class="toast-stack" aria-live="polite">
    {#each notifications.toasts as t (t.id)}
      <div
        class="toast toast-{t.kind}"
        role={t.kind === 'error' ? 'alert' : 'status'}
        aria-live={t.kind === 'error' ? 'assertive' : 'polite'}
      >
        <span class="toast-icon" aria-hidden="true">
          {#if t.kind === 'success'}
            <IconDone size={16} />
          {:else if t.kind === 'error'}
            <IconInfo size={16} />
          {:else}
            <IconInfo size={16} />
          {/if}
          <span class="sr-only">{kindLabel(t)}:</span>
        </span>
        <span class="toast-message">{t.message}</span>
        <button
          type="button"
          class="toast-dismiss"
          aria-label="Dismiss"
          onclick={() => dismiss(t)}
        >&times;</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-stack {
    position: fixed;
    right: var(--s-sp-4);
    bottom: var(--s-sp-4);
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
    max-width: min(360px, calc(100vw - var(--s-sp-8)));
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    padding: 0.5rem 1rem;
    background: color-mix(in srgb, var(--s-ink) 92%, var(--s-paper));
    color: var(--s-paper);
    border-radius: 2px;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    animation: toast-in 180ms var(--s-ease);
    pointer-events: auto;
  }

  /* Kind-specific left accent */
  .toast-info { border-left: 3px solid color-mix(in srgb, var(--s-ink-2) 60%, var(--s-paper)); }
  .toast-success { border-left: 3px solid var(--s-moss); }
  .toast-error { border-left: 3px solid var(--s-seal); }

  .toast-icon {
    flex-shrink: 0;
    display: inline-flex;
    color: var(--s-paper);
    opacity: 0.7;
  }

  .toast-message {
    flex: 1;
    line-height: 1.4;
    word-break: break-word;
  }

  .toast-dismiss {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    background: transparent;
    border: 0;
    color: var(--s-paper);
    opacity: 0.5;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    border-radius: 2px;
    transition: opacity var(--s-t-quick) var(--s-ease);
  }

  .toast-dismiss:hover,
  .toast-dismiss:focus-visible {
    opacity: 1;
    outline: none;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  @keyframes toast-in {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast { animation: none; }
  }
</style>
