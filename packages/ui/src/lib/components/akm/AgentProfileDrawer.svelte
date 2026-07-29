<script lang="ts">
	import Drawer from '$lib/components/common/Drawer.svelte';
	import type { AgentProfile } from './profile-types';

	// Slide-in editor for one agent-runner profile. Parent owns the draft
	// (deep-copied on open) and binds it here; this component keeps no copy.
	interface Props {
		draft: AgentProfile;
		oncancel: () => void;
		onapply: () => void;
	}
	let { draft = $bindable(), oncancel, onapply }: Props = $props();
</script>

<Drawer open={true} title="Agent profile" onClose={oncancel} width="40rem">
	<div class="controls controls--grid">
		<div class="control-group">
			<label class="control-label" for="d-agent-name">Profile Name</label>
			<input id="d-agent-name" class="control-input" type="text" spellcheck="false" placeholder="e.g. opencode" bind:value={draft.name} />
		</div>
		<div class="control-group">
			<label class="control-label" for="d-agent-platform">Platform</label>
			<select id="d-agent-platform" class="control-input" bind:value={draft.platform}>
				<option value="opencode">opencode</option>
				<option value="claude">claude</option>
				<option value="opencode-sdk">opencode-sdk</option>
			</select>
		</div>
		{#if draft.platform !== 'opencode-sdk'}
			<div class="control-group">
				<label class="control-label" for="d-agent-bin">Binary</label>
				<input id="d-agent-bin" class="control-input" type="text" spellcheck="false" placeholder="opencode" bind:value={draft.bin} />
			</div>
			<div class="control-group control-group--wide">
				<label class="control-label" for="d-agent-args">Extra args (space-separated)</label>
				<input id="d-agent-args" class="control-input" type="text" spellcheck="false" placeholder="run --model gpt-4o" bind:value={draft.args} />
			</div>
		{:else}
			<div class="control-group">
				<label class="control-label" for="d-agent-model">Model</label>
				<input id="d-agent-model" class="control-input" type="text" spellcheck="false" placeholder="anthropic/claude-sonnet-4-5" bind:value={draft.model} />
			</div>
			<div class="control-group">
				<label class="control-label" for="d-agent-workspace">Workspace</label>
				<input id="d-agent-workspace" class="control-input" type="text" spellcheck="false" placeholder={'${PWD}'} bind:value={draft.workspace} />
			</div>
		{/if}
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={oncancel}>Cancel</button>
		<button class="btn btn-primary" onclick={onapply}>Apply</button>
	{/snippet}
</Drawer>

<style>
	.controls { display: flex; flex-direction: column; gap: var(--s-sp-4); }
	.controls--grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: var(--s-sp-4); }
	.control-group { display: flex; flex-direction: column; gap: var(--s-sp-1); }
	.control-group--wide { grid-column: 1 / -1; }
	.control-label { font-family: var(--s-font-mono); font-size: var(--s-type-mark-sm); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-ink-3); }
	.control-input {
		border: 0;
		border-bottom: var(--s-hair) solid var(--s-line);
		background: none;
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		color: var(--s-ink);
		padding: 0.5rem 0;
		width: 100%;
	}
	.control-input:focus { outline: none; border-bottom-color: var(--s-ink-2); }
	.control-input:disabled { opacity: 0.4; cursor: not-allowed; }

</style>
