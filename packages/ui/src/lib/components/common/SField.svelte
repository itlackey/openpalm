<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** id of the control — wired to the label's `for`. */
    id: string;
    /** Visible label text. */
    label: string;
    /** The form control (input / select / textarea). */
    children: Snippet;
    /** Optional helper text shown below the control. */
    hint?: string;
    /** Error message shown below the control; takes priority over hint. */
    error?: string;
    /** Adds a `*` indicator to the label. */
    required?: boolean;
  }

  let { id, label, children, hint, error, required }: Props = $props();
</script>

<div class="s-field">
  <label class="s-label" for={id}>
    {label}{#if required}<span class="s-label-req" aria-hidden="true"> *</span>{/if}
  </label>
  {@render children()}
  {#if error}
    <span class="s-error-msg" role="alert">{error}</span>
  {:else if hint}
    <span class="s-hint">{hint}</span>
  {/if}
</div>

<style>
  .s-label-req { color: var(--s-seal); }
</style>
