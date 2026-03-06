<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    subtitle: string;
    children: Snippet;
  }

  let { title, subtitle, children }: Props = $props();
</script>

<section class="wizard-card">
  <div class="wizard-header">
    <h1>{title}</h1>
    <p class="wizard-subtitle">{subtitle}</p>
  </div>
  {@render children()}
</section>
