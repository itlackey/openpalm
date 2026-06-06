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
    gap: var(--space-2);
  }
  /* Self-contained input styling (matches the akm/log form inputs) so the
     component renders correctly wherever it's dropped. */
  .control-input {
    font-size: var(--text-sm);
    color: var(--color-text);
    background: var(--color-input-bg, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    flex: 1 1 auto;
    min-width: 0;
  }
  .control-input:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  .btn-icon {
    flex-shrink: 0;
    padding: 0 var(--space-3);
    min-height: 38px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .btn-icon:hover:not(:disabled) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
  .btn-icon:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .btn-icon:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
