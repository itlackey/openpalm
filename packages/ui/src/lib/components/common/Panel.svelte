<script lang="ts">
  // Standard surface panel: sticky header (title + optional actions) + body.
  // Renders the app-wide .panel / .panel-header design-system classes (defined
  // globally in app.css, like .btn), so the markup is identical to the
  // hand-rolled `<div class="panel">…</div>` it replaces. Everything below the
  // header is passed as children (callers keep their own `.panel-body`, since
  // some panels place controls/extra rows between header and body).
  import type { Snippet } from 'svelte';

  interface Props {
    /** Heading text rendered in the panel header. */
    title: string;
    /** Action button(s) shown at the right of the header. */
    actions?: Snippet;
    /** Panel content below the header (typically a `.panel-body`). */
    children: Snippet;
    /** ARIA role for the panel container (e.g. "tabpanel"). */
    role?: string;
  }

  let { title, actions, children, role }: Props = $props();
</script>

<div class="panel" {role}>
  <div class="panel-header">
    <h2>{title}</h2>
    {#if actions}
      <div class="panel-header-actions">{@render actions()}</div>
    {/if}
  </div>
  {@render children()}
</div>
