<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		open: boolean;
		onclose: () => void;
		children: Snippet;
		footer?: Snippet;
	}

	let { title, open, onclose, children, footer }: Props = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	function handleBackdrop(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}
</script>

{#if open}
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="modal-overlay"
	role="dialog"
	aria-modal="true"
	aria-label={title}
	onkeydown={handleKeydown}
	onclick={handleBackdrop}
>
	<div class="modal">
		<div class="modal-header">
			<h3>{title}</h3>
			<button class="close-btn" onclick={onclose} aria-label="Close">&times;</button>
		</div>
		<div class="modal-body">
			{@render children()}
		</div>
		{#if footer}
			<div class="modal-footer">
				{@render footer()}
			</div>
		{/if}
	</div>
</div>
{/if}

<style>
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 90;
	}
	.modal {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1.5rem;
		max-width: 560px;
		width: 95%;
		max-height: 80vh;
		overflow-y: auto;
	}
	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}
	.modal-header h3 { margin: 0; }
	.close-btn {
		background: transparent;
		color: var(--muted);
		font-size: 24px;
		padding: 0 0.3rem;
		line-height: 1;
	}
	.close-btn:hover { color: var(--text); }
	.modal-footer {
		margin-top: 1rem;
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
