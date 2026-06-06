<script lang="ts">
  // Labelled form control: label + control slot + optional hint/error.
  // Renders the app-wide .form-field / .form-label / .field-hint design-system
  // classes (defined globally in app.css), so markup matches the hand-rolled
  // `<div class="form-field"><label class="form-label">…</label>…</div>` it
  // replaces. The control itself is passed as children so `bind:value`, ids,
  // and events stay on the caller's element.
  import type { Snippet } from 'svelte';

  interface Props {
    /** Visible label text. */
    label: string;
    /** id of the control the label is `for`. */
    for: string;
    /** The form control (input/select/textarea). */
    children: Snippet;
    /** Optional helper text shown below the control. */
    hint?: string;
    /** Optional error message shown below the control. */
    error?: string;
  }

  let { label, for: forId, children, hint, error }: Props = $props();
</script>

<div class="form-field">
  <label class="form-label" for={forId}>{label}</label>
  {@render children()}
  {#if error}
    <p class="field-error">{error}</p>
  {:else if hint}
    <p class="field-hint">{hint}</p>
  {/if}
</div>

<style>
  .field-error {
    font-size: var(--text-xs);
    color: var(--color-danger);
  }
</style>
