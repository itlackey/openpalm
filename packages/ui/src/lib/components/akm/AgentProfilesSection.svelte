<script lang="ts">
	import ProfileRow from './ProfileRow.svelte';
	import type { AgentProfile } from './profile-types';

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
			<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
				<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>
				<circle cx="12" cy="10" r="2"/><path d="M9 10H7m10 0h-2"/>
			</svg>
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
	.badge {
		font-size: var(--text-xs); padding: 2px var(--space-2); border-radius: var(--radius-sm);
		background: var(--color-bg-tertiary, var(--color-bg-secondary)); color: var(--color-text-secondary);
		border: 1px solid var(--color-border); white-space: nowrap; flex-shrink: 0;
	}
</style>
