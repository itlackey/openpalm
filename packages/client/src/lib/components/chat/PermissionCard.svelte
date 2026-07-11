<script lang="ts">
  // B4 [HIGH] (review 2026-07-10) — copied from packages/ui ChatMessage's
  // PermissionCard.svelte (git show 455d8728 lineage) and adapted to the
  // client's own PendingPermissionState (chat-controller.ts) instead of the
  // host app's chat-state.svelte.js. Without this, any permission-gated tool
  // call wedged the turn for 150s with no reply path.
  import type { PendingPermissionState } from '$lib/chat/chat-controller.js';

  interface Props {
    permission: PendingPermissionState;
    /** Which decision is currently being submitted, for the "sending…" label. */
    actionInFlight: 'once' | 'always' | 'reject' | null;
    onReply: (reply: 'once' | 'always' | 'reject') => void;
  }

  let { permission, actionInFlight, onReply }: Props = $props();

  // Buttons lock once a decision is in flight or the request is resolved.
  const locked = $derived(permission.status === 'submitting' || permission.status === 'resolved');

  function clamp(text: string, max = 160): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
</script>

<div class="s-action-card" role="group" aria-label="Permission request">
  <div class="s-action-kicker">permission request</div>
  <div class="s-action-title">{permission.permission}</div>
  {#if permission.detail}
    <p class="s-action-body">{clamp(permission.detail)}</p>
  {/if}
  {#if permission.patterns.length > 0}
    <code class="s-action-code">{permission.patterns.join(', ')}</code>
  {/if}
  {#if permission.always.length > 0}
    <code class="s-action-code">{permission.always.join(', ')}</code>
  {/if}
  {#if permission.message}
    <p class="s-action-body">{permission.message}</p>
  {/if}
  <div class="s-action-btns">
    <button
      class="s-action-btn s-action-btn-primary"
      type="button"
      onclick={() => onReply('once')}
      disabled={locked}
    >
      {actionInFlight === 'once' ? 'sending…' : 'allow this once'}
    </button>
    <button
      class="s-action-btn"
      type="button"
      onclick={() => onReply('always')}
      disabled={locked}
    >
      {actionInFlight === 'always' ? 'sending…' : 'always allow'}
    </button>
    <button
      class="s-action-btn s-action-btn-danger"
      type="button"
      onclick={() => onReply('reject')}
      disabled={locked}
    >
      {actionInFlight === 'reject' ? 'sending…' : 'deny'}
    </button>
  </div>
</div>

<style>
  .s-action-card {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    padding: 1rem 1.2rem;
    border-left: var(--s-hair) solid var(--s-seal);
    max-width: var(--s-measure-whisper, 32rem);
  }

  .s-action-kicker {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm, var(--s-type-mark));
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-seal);
  }

  .s-action-title {
    font-family: var(--s-font-header);
    font-size: var(--s-type-whisper, var(--s-type-deed));
    color: var(--s-ink);
  }

  .s-action-body {
    font-family: var(--s-font-header);
    font-size: var(--s-type-whisper, var(--s-type-deed));
    color: var(--s-ink-2);
    margin: 0;
  }

  .s-action-code {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    display: block;
    word-break: break-all;
  }

  .s-action-btns {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.2rem;
  }

  .s-action-btn {
    appearance: none;
    border: var(--s-hair) solid var(--s-line);
    background: none;
    cursor: pointer;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    letter-spacing: var(--s-track-label);
    text-transform: lowercase;
    color: var(--s-ink-2);
    padding: 0.4rem 0.85rem;
    border-radius: var(--s-radius-seal, 4px);
    min-height: 44px;
    transition:
      color var(--s-t-quick) var(--s-ease),
      border-color var(--s-t-quick) var(--s-ease);
  }

  .s-action-btn:hover:not(:disabled) {
    color: var(--s-ink);
    border-color: var(--s-line);
  }

  .s-action-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .s-action-btn-primary {
    border-color: var(--s-seal);
    color: var(--s-seal);
  }

  .s-action-btn-danger {
    color: var(--s-ink-3);
  }
</style>
