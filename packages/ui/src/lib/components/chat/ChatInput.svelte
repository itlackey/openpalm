<script lang="ts">
  import Spinner from '$lib/components/common/Spinner.svelte';
  interface Props {
    sending: boolean;
    onSend: (text: string) => void;
  }

  let { sending, onSend }: Props = $props();

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
        <Spinner />
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
<!-- backend toggle moved to VoiceControl in the Navbar so it's available
     on every page (mic uses the same backend selection) -->

<style>
  .chat-input-row {
    display: flex;
    justify-content: center;
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .input-area {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    width: 100%;
    /* Match the centered message column width (see .messages-area). */
    max-width: var(--chat-column);
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
    width: 44px;
    height: 44px;
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

</style>
