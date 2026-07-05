<script lang="ts">
  import IconMic from '$lib/components/icons/IconMic.svelte';
  import IconSend from '$lib/components/icons/IconSend.svelte';
  import IconStop from '$lib/components/icons/IconStop.svelte';

  interface Props {
    sending: boolean;
    questionPending?: boolean;
    onSend: (text: string) => void;
    onStop?: () => void;
    voiceEnabled?: boolean;
    voiceActive?: boolean;
    onMicToggle?: () => void;
  }

  let { sending, questionPending = false, onSend, onStop, voiceEnabled = false, voiceActive = false, onMicToggle }: Props = $props();

  let inputText = $state('');
  let textareaEl = $state<HTMLTextAreaElement | undefined>();

  // Drafting the next message is always allowed; only submitting a turn
  // while the assistant is replying (and no single-question ask is pending)
  // is blocked.
  const submitBlocked = $derived(sending && !questionPending);
  const isActive = $derived(inputText.trim().length > 0);
  // While a turn is in flight (and no single-question ask needs the
  // composer for its answer), swap the send button for a stop button.
  const showStop = $derived(submitBlocked && !!onStop);

  function handleKeydown(e: KeyboardEvent): void {
    // IME composition (e.g. CJK input methods) commits candidates with
    // Enter — never treat that as a submit.
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit(): void {
    const text = inputText.trim();
    if (!text || submitBlocked) return;
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
    placeholder="Write a message..."
    rows="1"
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
    {#if showStop}
      <button
        class="s-send-btn"
        type="button"
        aria-label="Stop generating"
        onclick={onStop}
      >
        <IconStop size={16} />
      </button>
    {:else}
      <button
        class="s-send-btn"
        type="submit"
        aria-label="Send message"
        disabled={!isActive || submitBlocked}
      >
        <IconSend size={16} />
      </button>
    {/if}
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

  /* UX-09: keep the composer (and its right-side send button) clear of the
     fixed bottom-right corner glyphs on narrow screens by reserving symmetric
     horizontal breathing room. Symmetric padding preserves the centered look. */
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

  /* Footer row: rule line + optional mic/send buttons.
     UX-25: span the full composer (textarea) width so the action buttons read
     as part of the input rather than floating at the end of a short rule. */
  .s-footer {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
  }

  .s-mic-btn,
  .s-send-btn {
    flex-shrink: 0;
    appearance: none;
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--s-ink-3);
    /* UX-21: >= 44x44px hit area while the visual icon stays 16px.
       Negative block margin keeps the taller target from inflating the
       footer's vertical rhythm. */
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

  /* UX-22: respect reduced-motion — no infinite mic pulse, no active-scale. */
  @media (prefers-reduced-motion: reduce) {
    .s-mic-btn.active {
      animation: none;
    }

    .s-mic-btn:active,
    .s-send-btn:active {
      transform: none;
    }

    .s-mic-btn,
    .s-send-btn {
      transition: none;
    }
  }
</style>
