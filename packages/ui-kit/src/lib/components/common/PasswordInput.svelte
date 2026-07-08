<script lang="ts">
  // Reusable masked input with a show/hide toggle. The reveal state lives here;
  // the caller just binds the value.
  interface Props {
    value?: string;
    id?: string;
    placeholder?: string;
    disabled?: boolean;
  }
  let { value = $bindable(''), id, placeholder, disabled = false }: Props = $props();
  let show = $state(false);
</script>

<div class="input-with-toggle">
  <input
    {id}
    class="control-input"
    type={show ? 'text' : 'password'}
    spellcheck="false"
    autocomplete="new-password"
    {placeholder}
    bind:value
    {disabled}
  />
  <button
    type="button"
    class="btn-icon"
    onclick={() => { show = !show; }}
    aria-label={show ? 'Hide value' : 'Show value'}
    {disabled}
  >
    {show ? 'Hide' : 'Show'}
  </button>
</div>

<style>
  .input-with-toggle {
    display: flex;
    align-items: stretch;
    gap: var(--s-sp-2);
  }
  /* Self-contained input styling — Stillness underline input pattern. */
  .control-input {
    font-family: var(--s-font-display);
    font-size: var(--s-type-whisper);
    color: var(--s-ink);
    background: none;
    border: 0;
    border-bottom: var(--s-hair) solid var(--s-line);
    border-radius: 0;
    padding: 0.5rem 0;
    flex: 1 1 auto;
    min-width: 0;
  }
  .control-input:focus {
    outline: none;
    border-bottom-color: var(--s-ink-2);
  }
  .control-input::placeholder {
    color: var(--s-ink-3);
  }
  .btn-icon {
    flex-shrink: 0;
    padding: 0 var(--s-sp-2);
    min-height: 38px;
    background: none;
    border: 0;
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    cursor: pointer;
    transition: color var(--s-t-quick) var(--s-ease);
  }
  .btn-icon:hover:not(:disabled) {
    color: var(--s-ink-2);
  }
  .btn-icon:focus-visible {
    outline: 2px solid var(--s-ink-2);
    outline-offset: 2px;
  }
  .btn-icon:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
