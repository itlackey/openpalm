<script lang="ts">
	interface Props {
		steps: string[];
		current: number;
	}

	let { steps, current }: Props = $props();
</script>

<div class="steps">
	{#each steps as _, i}
		<div class="step-dot {i < current ? 'done' : i === current ? 'current' : ''}"></div>
	{/each}
</div>
