<script lang="ts">
	interface Props {
		missing: string[];
		onNavigate: () => void;
	}
	let { missing, onNavigate }: Props = $props();
</script>

{#if missing.length > 0}
	<div class="banner" role="alert">
		<span>Missing capabilities: {missing.join(', ')}.</span>
		<button class="banner-link" type="button" onclick={onNavigate}>Configure</button>
	</div>
{/if}

<style>
	.banner {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-5);
		background: var(--color-warning-bg, rgba(253, 126, 20, 0.1));
		border: 1px solid var(--color-warning-border, rgba(253, 126, 20, 0.25));
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
		color: var(--color-text);
		margin-bottom: var(--space-4);
	}
	.banner span { flex: 1; }
	.banner-link {
		background: none; border: none; color: var(--color-primary);
		font-size: var(--text-sm); font-weight: var(--font-semibold);
		cursor: pointer; text-decoration: underline;
	}
	.banner-link:hover { color: var(--color-primary-hover); }
</style>
