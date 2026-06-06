<script lang="ts">
	import type { Snippet } from 'svelte';

	// One compact row in an AKM profile list. Presentation only: the parent owns
	// the list + default-name state and handles set-default/edit/remove.
	interface Props {
		name: string;
		isDefault: boolean;
		disabled?: boolean;
		/** Optional badges/extras rendered after the name (e.g. platform, description). */
		extra?: Snippet;
		onsetdefault: () => void;
		onedit: () => void;
		onremove: () => void;
	}
	let { name, isDefault, disabled = false, extra, onsetdefault, onedit, onremove }: Props = $props();
</script>

<div class="profile-row">
	<span class="profile-row-name">{name || '(unnamed)'}</span>
	{#if extra}{@render extra()}{/if}
	{#if isDefault && name}
		<span class="badge badge--default">Default</span>
	{/if}
	<div class="profile-row-actions">
		{#if name && !isDefault}
			<button class="btn btn-sm" onclick={onsetdefault} {disabled}>Set Default</button>
		{/if}
		<button class="btn btn-sm" onclick={onedit} {disabled}>Edit</button>
		<button class="btn btn-sm btn-danger" onclick={onremove} {disabled}>Remove</button>
	</div>
</div>

<style>
	.profile-row {
		display: flex; align-items: center; gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border); border-radius: var(--radius-sm);
		background: var(--color-bg-secondary);
	}
	.profile-row-name { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.profile-row-actions { display: flex; gap: var(--space-2); flex-shrink: 0; }

	.badge {
		font-size: var(--text-xs); padding: 2px var(--space-2); border-radius: var(--radius-sm);
		background: var(--color-bg-tertiary, var(--color-bg-secondary)); color: var(--color-text-secondary);
		border: 1px solid var(--color-border); white-space: nowrap; flex-shrink: 0;
	}
	.badge--default {
		background: var(--color-primary-subtle, rgba(99, 102, 241, 0.1));
		color: var(--color-primary, #6366f1);
		border-color: var(--color-primary-border, rgba(99, 102, 241, 0.3));
	}
</style>
