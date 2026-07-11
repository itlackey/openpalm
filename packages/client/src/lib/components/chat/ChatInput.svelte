<script lang="ts">
  // Composer — adapted from packages/ui ChatInput.svelte (P5b item 3, #555)
  // minus the voice affordances (voice is host-app-only for now, plan
  // §12.2 decision (b)).
  //
  // review 2026-07-10 §B8 fixes:
  //   (a) IME guard — `shouldSubmitOnKeydown` (ported/extracted pure logic,
  //       tests/composer.test.ts) refuses to submit on the Enter that
  //       commits a CJK/Japanese/Korean IME composition candidate.
  //   (b) the textarea is never `disabled` — only the submit action is
  //       gated by `isSubmitBlocked`, so typing/drafting stays possible and
  //       focus is never destroyed to `<body>` (WCAG 2.4.3).
  // §B3 fix: a stop button replaces send while a turn is in flight.
  import IconSend from '@openpalm/ui-kit/components/icons/IconSend.svelte';
  import IconStop from '@openpalm/ui-kit/components/icons/IconStop.svelte';
  import { isSubmitBlocked, shouldSubmitOnKeydown } from '$lib/chat/composer.js';

  interface Props {
    sending: boolean;
    onSend: (text: string) => void;
    onStop?: () => void;
  }

  let { sending, onSend, onStop }: Props = $props();

  let inputText = $state('');
  let textareaEl = $state<HTMLTextAreaElement | undefined>();

  const isActive = $derived(inputText.trim().length > 0);
  const submitBlocked = $derived(isSubmitBlocked({ sending }));

  function handleKeydown(e: KeyboardEvent): void {
    if (!shouldSubmitOnKeydown({ key: e.key, shiftKey: e.shiftKey, isComposing: e.isComposing })) return;
    e.preventDefault();
    submit();
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
    {#if submitBlocked && onStop}
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
