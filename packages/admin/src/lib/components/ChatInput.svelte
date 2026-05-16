<script lang="ts">
  import type { ChatBackend } from '$lib/types.js';

  interface Props {
    backend: ChatBackend;
    sending: boolean;
    onSend: (text: string) => void;
    onBackendChange: (b: ChatBackend) => void;
  }

  let { backend, sending, onSend, onBackendChange }: Props = $props();

  let inputText = $state('');
  let textareaEl = $state<HTMLTextAreaElement | undefined>();

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit(): void {
    const text = inputText.trim();
    if (!text || sending) return;
    onSend(text);
    inputText = '';
    // Reset textarea height after clearing
    if (textareaEl) {
      textareaEl.style.height = 'auto';
    }
  }

  function handleInput(): void {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = `${textareaEl.scrollHeight}px`;
  }
</script>

<div class="chat-input-row">
  <div class="backend-toggle" role="group" aria-label="Select assistant backend">
    <button
      class="backend-btn"
      class:backend-btn-active={backend === 'assistant'}
      type="button"
      onclick={() => onBackendChange('assistant')}
      aria-pressed={backend === 'assistant'}
    >
      Assistant
    </button>
    <button
      class="backend-btn"
      class:backend-btn-active={backend === 'admin'}
      type="button"
      onclick={() => onBackendChange('admin')}
      aria-pressed={backend === 'admin'}
    >
      Admin
    </button>
  </div>

  <div class="input-area">
    <textarea
      id="chat-input"
      bind:this={textareaEl}
      bind:value={inputText}
      onkeydown={handleKeydown}
      oninput={handleInput}
      placeholder="Send a message… (Enter to send, Shift+Enter for newline)"
      rows="1"
      disabled={sending}
      aria-label="Message input"
    ></textarea>
    <button
      class="send-btn"
      type="button"
      disabled={sending || !inputText.trim()}
      onclick={submit}
      aria-label="Send message"
    >
      {#if sending}
        <span class="spinner" aria-hidden="true"></span>
      {:else}
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      {/if}
    </button>
  </div>
</div>

<style>
  .chat-input-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .backend-toggle {
    display: flex;
    gap: var(--space-1);
    align-self: flex-start;
  }

  .backend-btn {
    padding: 3px 10px;
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    background: var(--color-bg);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .backend-btn:hover {
    border-color: var(--color-border-hover);
    color: var(--color-text);
  }

  .backend-btn-active {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: #000;
    font-weight: var(--font-semibold);
  }

  .input-area {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
  }

  textarea {
    flex: 1;
    min-height: 40px;
    max-height: 160px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: var(--leading-normal);
    resize: none;
    overflow-y: auto;
    transition: border-color var(--transition-fast);
  }

  textarea:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
  }

  textarea:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }

  .send-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    flex-shrink: 0;
    background: var(--color-primary);
    border: none;
    border-radius: var(--radius-md);
    color: #000;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .send-btn:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .send-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
  }
</style>
