<script lang="ts">
  import type { ChatEntry } from '$lib/types.js';

  interface Props {
    entry: ChatEntry;
  }

  let { entry }: Props = $props();
</script>

{#if entry.type === 'divider'}
  <div class="thread-divider" aria-label={entry.label}>
    <span class="divider-line"></span>
    <span class="divider-label">{entry.label}</span>
    <span class="divider-line"></span>
  </div>
{:else}
  <div
    class="message"
    class:message-user={entry.role === 'user'}
    class:message-assistant={entry.role === 'assistant'}
    data-backend={entry.backend}
  >
    <div class="message-bubble">
      <p class="message-text">{entry.text}</p>
    </div>
    <span class="message-meta">
      {entry.role === 'user' ? 'You' : entry.backend === 'admin' ? 'Admin' : 'Assistant'}
      · {new Date(entry.timestamp).toLocaleTimeString()}
    </span>
  </div>
{/if}

<style>
  .thread-divider {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) 0;
    color: var(--color-text-tertiary);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .divider-line {
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }

  .divider-label {
    flex-shrink: 0;
    padding: 0 var(--space-2);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
  }

  .message {
    display: flex;
    flex-direction: column;
    max-width: 80%;
  }

  .message-user {
    align-self: flex-end;
    align-items: flex-end;
  }

  .message-assistant {
    align-self: flex-start;
    align-items: flex-start;
  }

  .message-bubble {
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-lg);
    line-height: var(--leading-normal);
  }

  .message-user .message-bubble {
    background: var(--color-primary);
    color: #000;
    border-bottom-right-radius: var(--radius-sm);
  }

  .message-assistant .message-bubble {
    background: var(--color-bg-tertiary);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-bottom-left-radius: var(--radius-sm);
  }

  /* Admin backend gets a subtle blue tint on the bubble */
  .message-assistant[data-backend='admin'] .message-bubble {
    background: var(--color-info-bg);
    border-color: rgba(51, 154, 240, 0.2);
  }

  .message-text {
    font-size: var(--text-base);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .message-meta {
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
  }
</style>
