<script lang="ts">
	import { getToasts, removeToast } from '$lib/stores/toast.svelte';

	const toasts = $derived(getToasts());
</script>

{#if toasts.length > 0}
	<div class="toast-container">
		{#each toasts as toast (toast.id)}
			<button
				class="toast toast-{toast.type}"
				role="alert"
				onclick={() => removeToast(toast.id)}
			>
				{toast.message}
			</button>
		{/each}
	</div>
{/if}
