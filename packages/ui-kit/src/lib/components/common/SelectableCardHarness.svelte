<script lang="ts">
  import SelectableCard from './SelectableCard.svelte';

  interface Props {
    onToggle: () => void;
  }

  let { onToggle }: Props = $props();
</script>

<SelectableCard title="OpenAI" description="1 model" expanded onToggle={onToggle}>
  <button data-testid="inner" type="button">Connect</button>
</SelectableCard>
