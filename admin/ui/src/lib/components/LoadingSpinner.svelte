<script lang="ts">
	interface Props {
		size?: number;
		message?: string;
	}

	let { size = 24, message }: Props = $props();
</script>

<div class="loading" role="status" aria-live="polite">
	<svg
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		class="spinner"
		aria-hidden="true"
	>
		<circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
		<path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
	</svg>
	{#if message}<span class="muted">{message}</span>{/if}
	<span class="sr-only">Loading</span>
</div>

<style>
	.loading {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		justify-content: center;
		padding: 1rem;
	}
	.spinner {
		animation: spin 0.8s linear infinite;
		color: var(--accent);
	}
	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
