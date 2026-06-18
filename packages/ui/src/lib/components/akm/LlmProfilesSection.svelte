<script lang="ts">
	import ProfileRow from './ProfileRow.svelte';
	import type { LlmProfile } from './profile-types';

	// Presentation-only list of LLM profiles. The parent (AkmTab) owns the array
	// and default-name state via $bindable; this component renders the rows and
	// raises edit/add/remove. Set-default mutates the bound default-name directly.
	interface Props {
		profiles: LlmProfile[];
		defaultName: string;
		disabled?: boolean;
		onedit: (p: LlmProfile) => void;
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
	<h3 class="section-title">Language models <span class="section-title-aka">akm LLM profiles</span></h3>
	<p class="section-note">The language models your assistant uses to organize and improve its memory. Add one per LLM service.</p>

	{#if profiles.length === 0}
		<div class="profile-empty">
			<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/>
			</svg>
			<p class="empty-note">No LLM profiles configured — add one below.</p>
		</div>
	{:else}
		<div class="profile-list">
			{#each profiles as p (p.id)}
				<ProfileRow
					name={p.name}
					isDefault={defaultName === p.name}
					{disabled}
					onsetdefault={() => { defaultName = p.name; }}
					onedit={() => onedit(p)}
					onremove={() => onremove(p.id)}
				/>
			{/each}
		</div>
	{/if}

	<button class="btn btn-secondary btn-sm" onclick={onadd} {disabled}>
		+ Add LLM Profile
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
	.profile-empty svg { opacity: 0.35; }
	.profile-list { display: flex; flex-direction: column; gap: 0; }
</style>
