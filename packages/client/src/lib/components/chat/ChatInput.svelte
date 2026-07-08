<script lang="ts">
  // Composer — adapted from packages/ui ChatInput.svelte (P5b item 3, #555)
  // minus the voice affordances (voice is host-app-only for now).
  import IconSend from '@openpalm/ui-kit/components/icons/IconSend.svelte';

  interface Props {
    sending: boolean;
    onSend: (text: string) => void;
  }

  let { sending, onSend }: Props = $props();

  let inputText = $state('');
  let textareaEl = $state<HTMLTextAreaElement | undefined>();

  const isActive = $derived(inputText.trim().length > 0);

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
    placeholder={sending ? '' : 'Write a message...'}
    rows="1"
    disabled={sending}
    aria-label="Message input"
    autocomplete="off"
    spellcheck="false"
  ></textarea>
  <div class="s-footer">
    <div class="s-rule"></div>
    <button
      class="s-send-btn"
      type="submit"
      aria-label="Send message"
      disabled={!isActive || sending}
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

  @media (max-width: 32rem) {
    .s-composer {
      padding-inline: clamp(1rem, 6vw, 2.5rem);
    }
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

  .s-footer {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
  }

  .s-send-btn {
    flex-shrink: 0;
    appearance: none;
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--s-ink-3);
    min-width: 44px;
    min-height: 44px;
    margin-block: -0.6rem;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: color var(--s-t-quick) var(--s-ease);
  }

  .s-send-btn:hover { color: var(--s-ink); }
  .s-send-btn:active { transform: scale(0.9); }

  .s-send-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

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

  @media (prefers-reduced-motion: reduce) {
    .s-send-btn:active {
      transform: none;
    }

    .s-send-btn {
      transition: none;
    }
  }
</style>
