<script lang="ts">
  interface Props {
    id: string;
    value: string;
    options: string[];
    placeholder: string;
    onChange?: (value: string) => void;
  }

  let { id, value = $bindable(), options, placeholder, onChange }: Props = $props();
</script>

{#if options.length > 0}
  <select
    id={id}
    value={value}
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
  <input id={id} type="text" bind:value placeholder={placeholder} />
{/if}
