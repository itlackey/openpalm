<script lang="ts">
	import PasswordInput from '@openpalm/ui-kit/components/common/PasswordInput.svelte';
	import Drawer from '@openpalm/ui-kit/components/common/Drawer.svelte';
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

<Drawer open={true} title="LLM profile" onClose={oncancel} width="40rem">
	<div class="profile-drawer-body">
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
		<label class="toggle-row" style="margin-top: var(--s-sp-4)">
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
		<div class="control-group control-group--wide" style="margin-top: var(--s-sp-4)">
		<label class="control-label" for="d-llm-extra">Extra params (JSON)</label>
		<textarea id="d-llm-extra" class="control-input" rows="3" spellcheck="false" placeholder={'{ "top_p": 0.9 }'} bind:value={draft.extraParams}></textarea>
		<span class="feat-hint">Merged into the provider request body. Must be a JSON object.</span>
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
	.control-label { font-size: var(--s-type-deed); font-weight: 400; color: var(--s-ink-2); }
	.control-input {
		font-size: var(--s-type-deed); color: var(--s-ink);
		background: var(--s-paper); border: var(--s-hair) solid var(--s-line);
		border-radius: 2px; padding: var(--s-sp-2) var(--s-sp-3); width: 100%;
	}
	.control-input--narrow { max-width: 8rem; }
	.control-input:focus { outline: 2px solid var(--s-seal); outline-offset: 1px; }
	.control-input:disabled { opacity: 0.5; cursor: not-allowed; }
	.profile-drawer-body { display: flex; flex-direction: column; gap: var(--s-sp-5); }

	.toggle-row { display: flex; align-items: center; gap: var(--s-sp-3); cursor: pointer; font-size: var(--s-type-deed); }
	.toggle-row input[type="checkbox"] { width: 1rem; height: 1rem; flex-shrink: 0; }
	.toggle-label { font-weight: 400; color: var(--s-ink); }
	.toggle-hint { color: var(--s-ink-2); font-size: var(--s-type-deed); }
	.feat-hint { font-size: var(--s-type-deed); color: var(--s-ink-2); }

</style>
