<script lang="ts">
	import ProfileRow from './ProfileRow.svelte';
	import type { ImproveProfile } from './profile-types';

	// Presentation-only list of memory-maintenance (improve) profiles. Parent owns
	// array + default-name via $bindable; this raises edit/add/remove. Each row
	// shows its optional description via ProfileRow's `extra` snippet.
	interface Props {
		profiles: ImproveProfile[];
		defaultName: string;
		disabled?: boolean;
		onedit: (ip: ImproveProfile) => void;
		onadd: () => void;
		onremove: (id: string) => void;
	}
	let {
		profiles = $bindable([]),
		defaultName = $bindable(''),
		disabled = false,
		onedit,
		onadd,
		onremove,
	}: Props = $props();
</script>

<section class="config-section">
	<h3 class="section-title">Memory maintenance <span class="section-title-aka">akm improve</span></h3>
	<p class="section-note">Scheduled runs that distill, deduplicate, and improve stored memories. Each configuration picks which steps run and which language model they use — add a language model above first.</p>

	{#if profiles.length === 0}
		<div class="profile-empty">
			<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<path d="M12 3c-1 2-2 3-3 4 1 3 3 5 3 8a6 6 0 0 1-6-6c0-3 2-5 3-6"/><path d="M17.5 3.5c.5 1.5.5 3-.5 4.5 1 1 2 2.5 2 4a4 4 0 0 1-4-4c0-2 1-3.5 2.5-4.5z"/>
			</svg>
			<p class="empty-note">No improve profiles defined — add one below.</p>
		</div>
	{:else}
		<div class="profile-list">
			{#each profiles as ip (ip.id)}
				<ProfileRow
					name={ip.name}
					isDefault={defaultName === ip.name}
					{disabled}
					onsetdefault={() => { defaultName = ip.name; }}
					onedit={() => onedit(ip)}
					onremove={() => onremove(ip.id)}
				>
					{#snippet extra()}
						{#if ip.description}
							<span class="profile-row-desc">{ip.description}</span>
						{/if}
					{/snippet}
				</ProfileRow>
			{/each}
		</div>
	{/if}

	<button class="btn btn-secondary btn-sm" onclick={onadd} {disabled}>
		+ Add Improve Profile
	</button>
</section>

<style>
	.config-section { display: flex; flex-direction: column; gap: var(--space-4); }
	.section-title {
		font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text);
		margin: 0;
		padding-bottom: var(--space-2); border-bottom: 1px solid var(--color-border);
	}
	.section-title-aka {
		font-size: var(--text-xs); font-weight: var(--font-normal);
		color: var(--color-text-secondary); font-family: var(--font-mono);
		margin-left: var(--space-2);
	}
	.section-note { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0; }
	.empty-note { font-size: var(--text-sm); color: var(--color-text-secondary); font-style: italic; margin: 0; }
	.profile-empty { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); margin-bottom: var(--space-2); color: var(--color-text-secondary); }
	.profile-empty svg { opacity: 0.45; }
	.profile-list { display: flex; flex-direction: column; gap: var(--space-1); }
	.profile-row-desc { font-size: var(--text-xs); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 20rem; }
</style>
