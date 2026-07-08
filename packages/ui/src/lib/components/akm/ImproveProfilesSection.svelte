<script lang="ts">
	import ProfileRow from './ProfileRow.svelte';
	import type { ImproveProfile } from './profile-types';
	import IconFlame from '@openpalm/ui-kit/components/icons/IconFlame.svelte';

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
			<IconFlame size={24} />
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
	.config-section { display: flex; flex-direction: column; gap: var(--s-sp-4); }
	.section-title {
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		font-weight: 400;
		color: var(--s-ink);
		margin: 0;
		padding-bottom: var(--s-sp-2);
		border-bottom: var(--s-hair) solid var(--s-line-soft);
	}
	.section-title-aka {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		color: var(--s-ink-3);
		margin-left: var(--s-sp-2);
	}
	.section-note { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-3); margin: 0; }
	.empty-note { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-3); margin: 0; }
	.profile-empty { display: flex; flex-direction: column; align-items: flex-start; gap: var(--s-sp-2); margin-bottom: var(--s-sp-2); color: var(--s-ink-3); }
	.profile-empty :global(.s-icon) { opacity: 0.35; }
	.profile-list { display: flex; flex-direction: column; gap: 0; }
	.profile-row-desc {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 20rem;
	}
</style>
