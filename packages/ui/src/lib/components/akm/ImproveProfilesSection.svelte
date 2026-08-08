<script lang="ts">
	import ProfileRow from './ProfileRow.svelte';
	import type { ImproveStrategy } from './profile-types';
	import IconFlame from '$lib/components/icons/IconFlame.svelte';

	// Presentation-only list of memory-maintenance improve strategies
	// (akm improve.strategies.<name>). Parent owns array + default-name via
	// $bindable; this raises edit/add/remove. Each row shows its optional
	// description via ProfileRow's `extra` snippet.
	interface Props {
		strategies: ImproveStrategy[];
		defaultName: string;
		disabled?: boolean;
		onedit: (st: ImproveStrategy) => void;
		onadd: () => void;
		onremove: (id: string) => void;
	}
	let {
		strategies = $bindable([]),
		defaultName = $bindable(''),
		disabled = false,
		onedit,
		onadd,
		onremove,
	}: Props = $props();
</script>

<section class="config-section">
	<h3 class="section-title">Memory maintenance <span class="section-title-aka">akm improve strategies</span></h3>
	<p class="section-note">Scheduled runs that distill, deduplicate, and improve stored memories. Each strategy picks which steps run and which engine they use — add an LLM engine above first.</p>

	{#if strategies.length === 0}
		<div class="profile-empty">
			<IconFlame size={24} />
			<p class="empty-note">No improve strategies defined — add one below.</p>
		</div>
	{:else}
		<div class="profile-list">
			{#each strategies as st (st.id)}
				<ProfileRow
					name={st.name}
					isDefault={defaultName === st.name}
					{disabled}
					onsetdefault={() => { defaultName = st.name; }}
					onedit={() => onedit(st)}
					onremove={() => onremove(st.id)}
				>
					{#snippet extra()}
						{#if st.description}
							<span class="profile-row-desc">{st.description}</span>
						{/if}
					{/snippet}
				</ProfileRow>
			{/each}
		</div>
	{/if}

	<button class="btn btn-secondary btn-sm" onclick={onadd} {disabled}>
		+ Add Improve Strategy
	</button>
</section>

<style>
	.config-section { display: flex; flex-direction: column; gap: var(--s-sp-4); min-width: 0; max-width: 100%; box-sizing: border-box; }
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
	.section-note { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-3); margin: 0; overflow-wrap: anywhere; }
	.empty-note { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-3); margin: 0; }
	.profile-empty { display: flex; flex-direction: column; align-items: flex-start; gap: var(--s-sp-2); margin-bottom: var(--s-sp-2); color: var(--s-ink-3); }
	.profile-empty :global(.s-icon) { opacity: 0.35; }
	.profile-list { display: flex; flex-direction: column; gap: 0; min-width: 0; max-width: 100%; box-sizing: border-box; }
	.config-section > :global(.btn) { min-height: 2.75rem; }
	.profile-row-desc {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-3);
		flex: 1 1 12rem;
		min-width: 0;
		max-width: 100%;
		white-space: normal;
		overflow-wrap: anywhere;
	}
</style>
