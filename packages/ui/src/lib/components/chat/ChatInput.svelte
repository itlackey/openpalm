<script lang="ts">
  import IconMic from '$lib/components/icons/IconMic.svelte';
  import IconSend from '$lib/components/icons/IconSend.svelte';

  interface Props {
    sending: boolean;
    questionPending?: boolean;
    onSend: (text: string) => void;
    voiceEnabled?: boolean;
    voiceActive?: boolean;
    onMicToggle?: () => void;
  }

  let { sending, questionPending = false, onSend, voiceEnabled = false, voiceActive = false, onMicToggle }: Props = $props();

  let inputText = $state('');
  let textareaEl = $state<HTMLTextAreaElement | undefined>();

  const inputDisabled = $derived(sending && !questionPending);
  const isActive = $derived(inputText.trim().length > 0);

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit(): void {
    const text = inputText.trim();
    if (!text || inputDisabled) return;
    onSend(text);
    inputText = '';
    if (textareaEl) {
      textareaEl.style.height = 'auto';
    }
  }

  function handleInput(): void {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, window.innerHeight * 0.3)}px`;
  }
</script>

<form
  class="s-composer"
  class:active={isActive}
  class:sending
  onsubmit={(e) => { e.preventDefault(); submit(); }}
>
  <textarea
    bind:this={textareaEl}
    bind:value={inputText}
    onkeydown={handleKeydown}
    oninput={handleInput}
    placeholder={sending && !questionPending ? '' : 'Write a message...'}
    rows="1"
    disabled={inputDisabled}
    aria-label="Message input"
    autocomplete="off"
    spellcheck="false"
  ></textarea>
  <div class="s-footer">
    <div class="s-rule"></div>
    {#if voiceEnabled}
      <button
        class="s-mic-btn"
        class:active={voiceActive}
        type="button"
        aria-label={voiceActive ? 'Stop listening' : 'Start listening'}
        aria-pressed={voiceActive}
        onclick={onMicToggle}
      >
        <IconMic size={16} />
      </button>
    {/if}
    <button
      class="s-send-btn"
      type="submit"
      aria-label="Send message"
      disabled={!isActive || inputDisabled}
    >
      <IconSend size={16} />
    </button>
  </div>
</form>

<style>
  .s-composer {
    width: min(34rem, 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.125rem;
  }

  .s-composer textarea {
    width: 100%;
    resize: none;
    border: 0;
    outline: 0;
    background: none;
    font-family: var(--s-font-header);
    font-weight: 400;
    font-size: var(--s-type-compose);
    line-height: 1.5;
    text-align: center;
    color: var(--s-ink);
    overflow: hidden;
    max-height: 30vh;
    padding: 0.2rem 0;
    transition: color var(--s-t-theme) var(--s-ease);
  }

  /* Footer row: rule line + optional mic button, sharing the same horizontal band */
  .s-footer {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: clamp(8rem, 60%, 20rem);
  }

  .s-mic-btn,
  .s-send-btn {
    flex-shrink: 0;
    appearance: none;
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--s-ink-3);
    padding: 0.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: color var(--s-t-quick) var(--s-ease);
  }

  .s-mic-btn:hover,
  .s-send-btn:hover { color: var(--s-ink); }

  .s-mic-btn:active,
  .s-send-btn:active { transform: scale(0.9); }

  .s-mic-btn.active {
    color: var(--s-seal);
    animation: s-mic-pulse 1.4s ease-in-out infinite;
  }

  .s-send-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  @keyframes s-mic-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }

  .s-mic-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 1px var(--s-paper), 0 0 0 2px var(--s-ink-3);
  }

  .s-mic-btn :global(.s-icon) { display: block; }

  .s-composer textarea::placeholder {
    color: var(--s-ink-3);
    opacity: 1;
  }

  .s-composer textarea:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .s-rule {
    flex: 1;
    height: 1px;
    background: var(--s-line);
    position: relative;
    transition: background var(--s-t-quick) var(--s-ease);
  }

  .s-rule::after {
    content: "";
    position: absolute;
    inset: 0;
    background: var(--s-seal);
    transform: scaleX(0);
    transform-origin: center;
    opacity: 0.7;
    transition: transform var(--s-t-quick) var(--s-ease);
  }

  .s-composer.active .s-rule::after {
    transform: scaleX(0.5);
  }

  .s-composer.sending .s-rule::after {
    animation: s-ripple 1s var(--s-ease);
  }
</style>
