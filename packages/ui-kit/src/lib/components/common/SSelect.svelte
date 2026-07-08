<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    id?: string;
    name?: string;
    /** Currently selected value (two-way bindable). */
    value: string;
    disabled?: boolean;
    required?: boolean;
    /** Applies `.s-select--error` styling. */
    error?: boolean;
    /** Extra CSS classes forwarded to the `<select>` element. */
    class?: string;
    /** `<option>` elements. */
    children: Snippet;
  }

  let {
    id,
    name,
    value = $bindable(),
    disabled,
    required,
    error,
    class: extraClass = '',
    children,
  }: Props = $props();
</script>

<div class="s-select-wrap">
  <select
    class="s-select {error ? 's-select--error' : ''} {extraClass}"
    {id}
    {name}
    {disabled}
    {required}
    bind:value
  >
    {@render children()}
  </select>
</div>
