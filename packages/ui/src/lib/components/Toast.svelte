<script lang="ts">
  /**
   * Global toast for voice errors (and any other transient alerts).
   *
   * Mounts once in the chat page (which is where the navbar lives in our
   * Electron sidecar mode). Observes voiceState.errorMessage; when it
   * appears, shows a fixed-position toast bottom-right for a short window
   * and then clears it. Replaces the inline `.voice-error` span that
   * caused horizontal overflow on narrow navbars.
   */
  import { voiceState } from '$lib/voice/voice-state.svelte.js';

  const TOAST_TIMEOUT_MS = 5_000;

  let dismissTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const msg = voiceState.errorMessage;
    if (!msg) return;
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => {
      voiceState.errorMessage = '';
      dismissTimer = null;
    }, TOAST_TIMEOUT_MS);
    return () => {
      if (dismissTimer) {
        clearTimeout(dismissTimer);
        dismissTimer = null;
      }
    };
  });

  function dismiss(): void {
    voiceState.errorMessage = '';
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
  }
</script>

{#if voiceState.errorMessage}
  <div class="toast" role="alert" aria-live="assertive">
    <span class="toast-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    </span>
    <span class="toast-message">{voiceState.errorMessage}</span>
    <button
      type="button"
      class="toast-dismiss"
      aria-label="Dismiss"
      onclick={dismiss}
    >&times;</button>
  </div>
{/if}

<style>
  .toast {
    position: fixed;
    right: var(--space-4);
    bottom: var(--space-4);
    z-index: 200;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    max-width: min(360px, calc(100vw - var(--space-8)));
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-danger, #dc2626);
    border-radius: var(--radius-md);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
    animation: toast-in 180ms ease-out;
  }

  .toast-icon {
    color: var(--color-danger, #dc2626);
    flex-shrink: 0;
    display: inline-flex;
  }

  .toast-message {
    flex: 1;
    font-size: var(--text-sm);
    line-height: 1.4;
    word-break: break-word;
  }

  .toast-dismiss {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    background: transparent;
    border: 0;
    color: var(--color-text-tertiary);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  .toast-dismiss:hover,
  .toast-dismiss:focus-visible {
    background: var(--color-surface-hover);
    color: var(--color-text);
    outline: none;
  }

  @keyframes toast-in {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast { animation: none; }
  }
</style>
