<script lang="ts">
	import PasswordInput from '$lib/components/common/PasswordInput.svelte';
	import type { LlmProfile } from './profile-types';

	// Slide-in editor for one LLM profile. The parent (AkmTab) owns the draft
	// (deep-copied on open) and binds it here — this component does NOT keep its
	// own copy. Cancel/Apply are raised back; the parent commits the draft.
	interface Props {
		draft: LlmProfile;
		oncancel: () => void;
		onapply: () => void;
	}
	let { draft = $bindable(), oncancel, onapply }: Props = $props();
</script>

<div class="drawer-scrim" role="presentation" onclick={oncancel}></div>

<div class="drawer" role="dialog" aria-modal="true" aria-label="Edit profile">
	<div class="drawer-header">
		<h3 class="drawer-title">LLM Profile</h3>
		<button class="drawer-close" onclick={oncancel} aria-label="Close">✕</button>
	</div>

	<div class="drawer-body">
		<div class="controls controls--grid">
			<div class="control-group">
				<label class="control-label" for="d-llm-name">Profile Name</label>
				<input id="d-llm-name" class="control-input" type="text" spellcheck="false" placeholder="e.g. default" bind:value={draft.name} />
			</div>
			<div class="control-group control-group--wide">
				<label class="control-label" for="d-llm-endpoint">Endpoint</label>
				<input id="d-llm-endpoint" class="control-input" type="url" spellcheck="false" placeholder="https://api.openai.com/v1/chat/completions" bind:value={draft.endpoint} />
			</div>
			<div class="control-group">
				<label class="control-label" for="d-llm-model">Model</label>
				<input id="d-llm-model" class="control-input" type="text" spellcheck="false" placeholder="gpt-4o-mini" bind:value={draft.model} />
			</div>
			<div class="control-group">
				<label class="control-label" for="d-llm-provider">Provider (label)</label>
				<input id="d-llm-provider" class="control-input" type="text" spellcheck="false" placeholder="openai" bind:value={draft.provider} />
			</div>
			<div class="control-group">
				<label class="control-label" for="d-llm-apikey">API Key</label>
				<PasswordInput id="d-llm-apikey" placeholder={'${AKM_LLM_API_KEY}'} bind:value={draft.apiKey} />
			</div>
			<div class="control-group">
				<label class="control-label" for="d-llm-temperature">Temperature (0–2)</label>
				<input id="d-llm-temperature" class="control-input control-input--narrow" type="number" min="0" max="2" step="0.1" bind:value={draft.temperature} />
			</div>
			<div class="control-group">
				<label class="control-label" for="d-llm-maxtokens">Max tokens</label>
				<input id="d-llm-maxtokens" class="control-input control-input--narrow" type="number" min="1" bind:value={draft.maxTokens} />
			</div>
			<div class="control-group">
				<label class="control-label" for="d-llm-timeout">Timeout (ms)</label>
				<input id="d-llm-timeout" class="control-input control-input--narrow" type="number" min="1" bind:value={draft.timeoutMs} />
			</div>
			<div class="control-group">
				<label class="control-label" for="d-llm-concurrency">Concurrency</label>
				<input id="d-llm-concurrency" class="control-input control-input--narrow" type="number" min="1" bind:value={draft.concurrency} />
			</div>
			<div class="control-group">
				<label class="control-label" for="d-llm-contextlength">Context length</label>
				<input id="d-llm-contextlength" class="control-input control-input--narrow" type="number" min="1" bind:value={draft.contextLength} />
			</div>
			<div class="control-group">
				<label class="control-label" for="d-llm-judgemodel">Judge model</label>
				<input id="d-llm-judgemodel" class="control-input" type="text" spellcheck="false" placeholder="gpt-4o" bind:value={draft.judgeModel} />
			</div>
		</div>
		<label class="toggle-row" style="margin-top: var(--space-4)">
			<input type="checkbox" bind:checked={draft.supportsJsonSchema} />
			<span class="toggle-label">Supports JSON schema</span>
			<span class="toggle-hint">Use response_format: json_schema for structured output</span>
		</label>
		<label class="toggle-row">
		<input type="checkbox" bind:checked={draft.structuredOutput} />
		<span class="toggle-label">Structured output capability</span>
		<span class="toggle-hint">capabilities.structuredOutput — model reliably returns valid structured JSON</span>
		</label>
		<label class="toggle-row">
		<input type="checkbox" bind:checked={draft.enableThinking} />
		<span class="toggle-label">Enable thinking</span>
		<span class="toggle-hint">Allow extended/thinking tokens for reasoning models</span>
		</label>
		<div class="control-group control-group--wide" style="margin-top: var(--space-4)">
		<label class="control-label" for="d-llm-extra">Extra params (JSON)</label>
		<textarea id="d-llm-extra" class="control-input" rows="3" spellcheck="false" placeholder={'{ "top_p": 0.9 }'} bind:value={draft.extraParams}></textarea>
		<span class="feat-hint">Merged into the provider request body. Must be a JSON object.</span>
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
	.control-input--narrow { max-width: 8rem; }
	.control-input:focus { outline: 2px solid var(--color-primary); outline-offset: 1px; }
	.control-input:disabled { opacity: 0.5; cursor: not-allowed; }

	.toggle-row { display: flex; align-items: center; gap: var(--space-3); cursor: pointer; font-size: var(--text-sm); }
	.toggle-row input[type="checkbox"] { width: 1rem; height: 1rem; flex-shrink: 0; }
	.toggle-label { font-weight: var(--font-medium); color: var(--color-text); }
	.toggle-hint { color: var(--color-text-secondary); font-size: var(--text-xs); }
	.feat-hint { font-size: var(--text-xs); color: var(--color-text-secondary); }

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
