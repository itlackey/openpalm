<script lang="ts">
  interface Props {
    sending: boolean;
    questionPending?: boolean;
    onSend: (text: string) => void;
  }

  let { sending, questionPending = false, onSend }: Props = $props();

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
    placeholder={sending && !questionPending ? '' : 'Write…'}
    rows="1"
    disabled={inputDisabled}
    aria-label={questionPending ? 'Answer the assistant' : 'Speak to the agent'}
    autocomplete="off"
    spellcheck="false"
  ></textarea>
  <div class="s-rule"></div>
</form>

<style>
  .s-composer {
    width: min(40rem, 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.55rem;
  }

  .s-composer textarea {
    width: 100%;
    resize: none;
    border: 0;
    outline: 0;
    background: none;
    font-family: var(--s-font-display);
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

  .s-composer textarea::placeholder {
    color: var(--s-ink-3);
    opacity: 1;
  }

  .s-composer textarea:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .s-rule {
    width: clamp(8rem, 60%, 20rem);
    height: 1px;
    background: var(--s-line);
    position: relative;
    transition: width var(--s-t-settle) var(--s-ease), background var(--s-t-quick) var(--s-ease);
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
