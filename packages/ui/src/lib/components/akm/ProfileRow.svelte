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
		display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-sp-2);
		padding: var(--s-sp-2) var(--s-sp-3);
		border-bottom: var(--s-hair) solid var(--s-line-soft);
		width: 100%; max-width: 100%; min-width: 0;
		box-sizing: border-box;
	}
	.profile-row-name {
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		color: var(--s-ink);
		flex: 1 1 10rem; min-width: 0;
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.profile-row-actions {
		display: flex;
		flex: 0 1 auto;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--s-sp-2);
		margin-left: auto;
		max-width: 100%;
		min-width: 0;
	}
	.profile-row-actions :global(.btn) {
		min-height: 2.75rem;
		max-width: 100%;
	}
	.profile-row-actions :global(.btn-danger) {
		color: var(--s-error);
		border-color: var(--s-error);
		background: transparent;
		opacity: 1;
	}
	.profile-row-actions :global(.btn-danger:disabled) { opacity: 0.38; }

	.badge {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		padding: 1px var(--s-sp-2);
		border-radius: 2px;
		background: color-mix(in srgb, var(--s-ink) 4%, var(--s-paper));
		color: var(--s-ink-3);
		border: var(--s-hair) solid var(--s-line-soft);
		white-space: nowrap;
		flex-shrink: 0;
		max-width: 100%;
	}
	.badge--default {
		color: var(--s-seal);
		border-color: var(--s-seal);
		background: color-mix(in srgb, var(--s-seal) 6%, var(--s-paper));
	}
</style>
