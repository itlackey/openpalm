<script lang="ts">
	import { toasts } from '$lib/stores/toast';
</script>

{#if $toasts.length > 0}
<div class="toast-container" aria-live="polite">
	{#each $toasts as toast (toast.id)}
		<div class="toast toast-{toast.type}" role="alert">
			{toast.message}
		</div>
	{/each}
</div>
{/if}

<style>
	.toast-container {
		position: fixed;
		top: 60px;
		right: 1rem;
		z-index: 200;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.toast {
		padding: 0.7rem 1.2rem;
		border-radius: var(--radius);
		font-size: 14px;
		animation: toast-in 0.3s ease;
		max-width: 380px;
		border: 1px solid var(--border);
	}
	.toast-success { background: var(--surface); border-color: var(--green); color: var(--green); }
	.toast-error { background: var(--surface); border-color: var(--red); color: var(--red); }
	.toast-info { background: var(--surface); border-color: var(--accent); color: var(--text); }

	@keyframes toast-in {
		from { opacity: 0; transform: translateX(1rem); }
		to { opacity: 1; transform: none; }
	}
</style>
