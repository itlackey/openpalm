<script lang="ts">
  interface Props {
    id: string;
    value: string;
    options: string[];
    placeholder: string;
    onChange?: (value: string) => void;
  }

  let { id, value = $bindable(), options, placeholder, onChange }: Props = $props();

  function syncDefault(el: HTMLSelectElement) {
    if (!value && options.length > 0) {
      value = options[0];
      onChange?.(options[0]);
    }
  }
</script>

{#if options.length > 0}
  <select
    class="model-select"
    id={id}
    value={value}
    use:syncDefault
    onchange={(e) => {
      const next = e.currentTarget.value;
      value = next;
      onChange?.(next);
    }}
  >
    {#each options as option}
      <option value={option}>{option}</option>
    {/each}
  </select>
{:else}
  <input
    class="model-input"
    id={id}
    type="text"
    value={value}
    placeholder={placeholder}
    oninput={(e) => {
      value = e.currentTarget.value;
      onChange?.(e.currentTarget.value);
    }}
  />
{/if}

<style>
  .model-input,
  .model-select {
    width: 100%;
    height: 44px;
    border: 1.5px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 0 14px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-base);
    transition: all 0.2s ease;
  }
  .model-input::placeholder { color: var(--color-text-tertiary); }
  .model-input:hover,
  .model-select:hover { border-color: var(--color-border-hover); }
  .model-input:focus,
  .model-select:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 4px var(--color-primary-subtle); }
</style>
