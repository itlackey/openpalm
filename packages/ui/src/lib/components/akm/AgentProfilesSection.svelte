<script lang="ts">
	import ProfileRow from './ProfileRow.svelte';
	import type { AgentProfile } from './profile-types';
	import IconAgent from '@openpalm/ui-kit/components/icons/IconAgent.svelte';

	// Presentation-only list of agent-runner profiles. Parent owns array +
	// default-name via $bindable; this raises edit/add/remove. Each row gets a
	// platform badge through ProfileRow's `extra` snippet.
	interface Props {
		profiles: AgentProfile[];
		defaultName: string;
		disabled?: boolean;
		onedit: (p: AgentProfile) => void;
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
	<h3 class="section-title">Agent runners <span class="section-title-aka">akm agent profiles</span></h3>
	<p class="section-note">Runner configs for maintenance steps that spawn a subprocess (opencode or claude CLI).</p>

	{#if profiles.length === 0}
		<div class="profile-empty">
			<IconAgent size={24} />
			<p class="empty-note">No agent profiles defined.</p>
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
				>
					{#snippet extra()}
						<span class="badge">{p.platform}</span>
					{/snippet}
				</ProfileRow>
			{/each}
		</div>
	{/if}

	<button class="btn btn-secondary btn-sm" onclick={onadd} {disabled}>
		+ Add Agent Profile
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
	}
</style>
