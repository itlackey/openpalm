<script lang="ts">
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

<div class="drawer-scrim" role="presentation" onclick={oncancel}></div>

<div class="drawer" role="dialog" aria-modal="true" aria-label="Edit profile">
	<div class="drawer-header">
		<h3 class="drawer-title">Agent Profile</h3>
		<button class="drawer-close" onclick={oncancel} aria-label="Close">✕</button>
	</div>

	<div class="drawer-body">
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
	</div>

	<div class="drawer-footer">
		<button class="btn btn-secondary" onclick={oncancel}>Cancel</button>
		<button class="btn btn-primary" onclick={onapply}>Apply</button>
	</div>
</div>

<style>
	.controls { display: flex; flex-direction: column; gap: var(--space-4); }
	.controls--grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: var(--space-4); }
	.control-group { display: flex; flex-direction: column; gap: var(--space-1); }
	.control-group--wide { grid-column: 1 / -1; }
	.control-label { font-size: var(--text-xs); font-weight: var(--font-medium); color: var(--color-text-secondary); }
	.control-input {
		font-size: var(--text-sm); color: var(--color-text);
		background: var(--color-input-bg, var(--color-bg)); border: 1px solid var(--color-border);
		border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); width: 100%;
	}
	.control-input:focus { outline: 2px solid var(--color-primary); outline-offset: 1px; }
	.control-input:disabled { opacity: 0.5; cursor: not-allowed; }

	.drawer-scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 200; }
	.drawer {
		position: fixed; top: 0; right: 0; bottom: 0;
		width: min(640px, 92vw);
		background: var(--color-bg);
		border-left: 1px solid var(--color-border);
		box-shadow: -4px 0 32px rgba(0, 0, 0, 0.2);
		z-index: 201;
		display: flex; flex-direction: column;
		animation: drawer-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	@keyframes drawer-in { from { transform: translateX(100%); } to { transform: translateX(0); } }
	.drawer-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-4) var(--space-6);
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
	}
	.drawer-title { font-size: var(--text-base); font-weight: var(--font-semibold); color: var(--color-text); margin: 0; }
	.drawer-close {
		width: 2rem; height: 2rem; border-radius: var(--radius-sm);
		background: transparent; border: 1px solid var(--color-border);
		color: var(--color-text-secondary); cursor: pointer; font-size: var(--text-sm);
		display: flex; align-items: center; justify-content: center;
	}
	.drawer-close:hover { background: var(--color-surface-hover); color: var(--color-text); }
	.drawer-body { flex: 1; overflow-y: auto; padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-5); }
	.drawer-footer {
		display: flex; justify-content: flex-end; gap: var(--space-3);
		padding: var(--space-4) var(--space-6);
		border-top: 1px solid var(--color-border);
		flex-shrink: 0;
	}
</style>
