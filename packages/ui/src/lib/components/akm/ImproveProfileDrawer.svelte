<script lang="ts">
	import Drawer from '$lib/components/common/Drawer.svelte';
	import { PROCESS_KEYS, PROCESS_HINTS } from './improve-process-helpers';
	import type { ImproveProfile } from './profile-types';

	// Slide-in editor for one memory-maintenance (improve) profile. Parent owns
	// the draft (deep-copied on open, including per-process objects) and binds it
	// here; this component keeps no copy. The LLM profile names feed the datalist
	// used by the per-process `profile` + judgment `profile` inputs.
	interface Props {
		draft: ImproveProfile;
		llmProfileNames: string[];
		oncancel: () => void;
		onapply: () => void;
	}
	let { draft = $bindable(), llmProfileNames, oncancel, onapply }: Props = $props();
</script>

<datalist id="llm-profiles-list">
	{#each llmProfileNames as name (name)}<option value={name}></option>{/each}
</datalist>

<Drawer open={true} title="Improve profile" onClose={oncancel} width="40rem">
	<div class="profile-drawer-body">
		<div class="controls controls--grid">
			<div class="control-group">
				<label class="control-label" for="d-imp-name">Profile Name</label>
				<input id="d-imp-name" class="control-input" type="text" spellcheck="false" placeholder="e.g. default" bind:value={draft.name} />
			</div>
			<div class="control-group control-group--wide">
				<label class="control-label" for="d-imp-desc">Description</label>
				<input id="d-imp-desc" class="control-input" type="text" spellcheck="false" placeholder="Optional description" bind:value={draft.description} />
			</div>
			<div class="control-group">
				<label class="control-label" for="d-imp-limit">Max proposals per run</label>
				<input id="d-imp-limit" class="control-input control-input--narrow" type="number" min="1" max="100" bind:value={draft.limit} />
			</div>
			<div class="control-group">
				<label class="control-label" for="d-imp-autoacc">Auto-accept threshold (0 = manual)</label>
				<input id="d-imp-autoacc" class="control-input control-input--narrow" type="number" min="0" max="1" step="0.05" bind:value={draft.autoAccept} />
			</div>
		</div>

		<div class="proc-list">
			{#each PROCESS_KEYS as key (key)}
				{@const proc = draft.processes[key]}
				<div class="proc-card">
					<div class="proc-head">
						<input type="checkbox" bind:checked={proc.enabled} aria-label="{key} enabled" />
						<div class="proc-name"><span class="feat-name">{key}</span><span class="feat-hint">{PROCESS_HINTS[key]}</span></div>
						<select class="control-input" bind:value={proc.mode} aria-label="{key} mode">
							<option value="">Default mode</option>
							<option value="llm">LLM (direct call)</option>
							<option value="agent">Agent (subprocess)</option>
							<option value="sdk">SDK (programmatic)</option>
						</select>
						<input class="control-input" type="text" spellcheck="false" list="llm-profiles-list" placeholder="— default profile —" bind:value={proc.profile} aria-label="{key} profile" />
						<input class="control-input control-input--narrow" type="number" min="1" placeholder="timeout ms" bind:value={proc.timeoutMs} aria-label="{key} timeout" />
					</div>
					<details class="proc-adv">
						<summary>Advanced</summary>
						<div class="proc-adv-grid">
							<label class="adv-field"><span>Allowed types (comma-separated)</span>
								<input class="control-input" type="text" spellcheck="false" placeholder="skill, knowledge, …" bind:value={proc.allowedTypes} />
							</label>
							{#if key === 'reflect' || key === 'distill'}
								<label class="adv-field"><span>Quality gate</span>
									<select class="control-input" bind:value={proc.qualityGate}>
										<option value="">Default</option><option value="on">Enabled</option><option value="off">Disabled</option>
									</select>
								</label>
							{/if}
							{#if key === 'consolidate'}
								<label class="adv-field"><span>Contradiction detection</span>
									<select class="control-input" bind:value={proc.contradictionDetection}>
										<option value="">Default</option><option value="on">Enabled</option><option value="off">Disabled</option>
									</select>
								</label>
							{/if}
							{#if key === 'extract'}
								<label class="adv-field"><span>Default since</span>
									<input class="control-input" type="text" spellcheck="false" placeholder="e.g. 7d, 2026-01-01" bind:value={proc.defaultSince} />
								</label>
								<label class="adv-field"><span>Max total chars</span>
									<input class="control-input control-input--narrow" type="number" min="1" bind:value={proc.maxTotalChars} />
								</label>
								<label class="adv-field"><span>Max chunk size (1–50)</span>
									<input class="control-input control-input--narrow" type="number" min="1" max="50" bind:value={proc.maxChunkSize} />
								</label>
							{/if}
							{#if key === 'triage'}
								<label class="adv-field"><span>Apply mode</span>
									<select class="control-input" bind:value={proc.applyMode}>
										<option value="">Default</option><option value="queue">Queue</option><option value="promote">Promote</option>
									</select>
								</label>
								<label class="adv-field"><span>Policy</span>
									<input class="control-input" type="text" spellcheck="false" placeholder="policy name/ref" bind:value={proc.policy} />
								</label>
								<label class="adv-field"><span>Max accepts per run</span>
									<input class="control-input control-input--narrow" type="number" min="1" bind:value={proc.maxAcceptsPerRun} />
								</label>
								<label class="adv-field"><span>Max diff lines</span>
									<input class="control-input control-input--narrow" type="number" min="1" bind:value={proc.maxDiffLines} />
								</label>
								<label class="adv-field adv-field--check">
									<input type="checkbox" bind:checked={proc.rejectEmpty} /> <span>Reject empty diffs</span>
								</label>
								<div class="adv-field adv-field--wide">
									<span class="adv-sublabel">Judgment (overrides for the accept/reject decision)</span>
									<div class="proc-adv-grid">
										<label class="adv-field"><span>Mode</span>
											<select class="control-input" bind:value={proc.judgment.mode}>
												<option value="">Default</option><option value="llm">LLM</option><option value="agent">Agent</option><option value="sdk">SDK</option>
											</select>
										</label>
										<label class="adv-field"><span>Profile</span>
											<input class="control-input" type="text" spellcheck="false" list="llm-profiles-list" bind:value={proc.judgment.profile} />
										</label>
										<label class="adv-field"><span>Timeout (ms)</span>
											<input class="control-input control-input--narrow" type="number" min="1" bind:value={proc.judgment.timeoutMs} />
										</label>
									</div>
								</div>
							{/if}
						</div>
					</details>
				</div>
			{/each}
		</div>

		<!-- Profile-level git sync (akm ImproveProfileConfigSchema.sync) -->
		<div class="controls controls--grid">
			<div class="control-group">
				<label class="control-label" for="d-imp-sync">Git sync after run</label>
				<select id="d-imp-sync" class="control-input" bind:value={draft.syncEnabled}>
					<option value="">Default</option><option value="on">Enabled</option><option value="off">Disabled</option>
				</select>
			</div>
			<div class="control-group">
				<label class="control-label" for="d-imp-syncpush">Push to remote</label>
				<select id="d-imp-syncpush" class="control-input" bind:value={draft.syncPush}>
					<option value="">Default</option><option value="on">Enabled</option><option value="off">Disabled</option>
				</select>
			</div>
			<div class="control-group control-group--wide">
				<label class="control-label" for="d-imp-syncmsg">Commit message</label>
				<input id="d-imp-syncmsg" class="control-input" type="text" spellcheck="false" placeholder="Optional commit message" bind:value={draft.syncMessage} />
			</div>
		</div>
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
	.control-input--narrow { max-width: 8rem; }
	.control-input:focus { outline: none; border-bottom-color: var(--s-ink-2); }
	.control-input:disabled { opacity: 0.4; cursor: not-allowed; }
	.profile-drawer-body { display: flex; flex-direction: column; gap: var(--s-sp-5); }

	/* Improve drawer process labels */
	.feat-name {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink);
		display: block;
	}
	.feat-hint { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-3); }

	/* Improve process cards */
	.proc-list { display: flex; flex-direction: column; gap: var(--s-sp-2); }
	.proc-card {
		border: var(--s-hair) solid var(--s-line-soft);
		border-radius: 2px;
		background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
		padding: var(--s-sp-3);
	}
	.proc-head { display: grid; grid-template-columns: 1.5rem 1fr 9rem 11rem 7rem; align-items: center; gap: var(--s-sp-2); }
	@media (max-width: 600px) {
		.proc-head { grid-template-columns: 1.5rem 1fr; }
		.proc-head > :nth-child(n+3) { grid-column: 1 / -1; }
	}
	.proc-head input[type="checkbox"] { width: 1rem; height: 1rem; accent-color: var(--s-seal); }
	.proc-name { min-width: 0; }
	.proc-adv { margin-top: var(--s-sp-2); }
	.proc-adv > summary {
		cursor: pointer;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		user-select: none;
		list-style: none;
	}
	.proc-adv > summary:hover { color: var(--s-ink-2); }
	.proc-adv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: var(--s-sp-2); margin-top: var(--s-sp-2); }
	.adv-field { display: flex; flex-direction: column; gap: 2px; }
	.adv-field > span {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
	}
	.adv-field--check { flex-direction: row; align-items: center; gap: var(--s-sp-2); }
	.adv-field--check input[type="checkbox"] { accent-color: var(--s-seal); }
	.adv-field--wide { grid-column: 1 / -1; }
	.adv-sublabel {
		display: block;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		margin-bottom: 2px;
	}

</style>
