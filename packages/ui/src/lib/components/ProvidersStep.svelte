<script lang="ts">
	import { getSetupState } from '$lib/stores/setup.svelte';

	interface Props {
		error: string;
	}

	let { error }: Props = $props();

	const state = $derived(getSetupState());
	const openmemoryProvider = $derived(
		state?.openmemoryProvider ?? { openaiBaseUrl: '', openaiApiKeyConfigured: false }
	);
	const smallModelProvider = $derived(
		state?.smallModelProvider ?? { endpoint: '', modelId: '', apiKeyConfigured: false }
	);
	const serviceInstances = $derived(
		state?.serviceInstances ?? { openmemory: '', psql: '', qdrant: '' }
	);
</script>

<p>
	Connect an AI model so your assistant can respond. You need at least an Anthropic API key.
</p>

{#if error}
	<div class="wiz-error visible">{error}</div>
{/if}

<div class="sec-box">
	<div class="sec-title">AI Assistant Model</div>
	<div class="muted" style="font-size:12px;margin-bottom:0.5rem">
		<strong>Required.</strong> This is the brain of your assistant. If you don't have a key yet,
		<a href="https://console.anthropic.com/" target="_blank" rel="noopener">create one at console.anthropic.com</a>
		(sign up is free, you pay per use).
	</div>
	<label style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Anthropic API Key</label>
	<input id="wiz-anthropic-key" type="password" placeholder="sk-ant-..." value="" />
	{#if state?.anthropicKeyConfigured}
		<div class="muted" style="font-size:12px;margin-top:0.2rem">
			API key already configured. Leave blank to keep current key.
		</div>
	{/if}
</div>

<div class="sec-box">
	<div class="sec-title">Memory System</div>
	<div class="muted" style="font-size:12px;margin-bottom:0.5rem">
		Optional but recommended. Lets your assistant remember past conversations. Uses an
		OpenAI-compatible API for embeddings. If you skip this, memory features won't work.
	</div>
	<label style="display:block;margin:0.5rem 0 0.2rem;font-size:13px"
		>AI model endpoint for memory</label
	>
	<input
		id="wiz-openmemory-openai-base"
		placeholder="e.g. https://api.openai.com/v1 (leave blank for default)"
		value={openmemoryProvider.openaiBaseUrl || ''}
	/>
	<label style="display:block;margin:0.5rem 0 0.2rem;font-size:13px"
		>AI model API key for memory</label
	>
	<input id="wiz-openmemory-openai-key" type="password" placeholder="sk-..." value="" />
	{#if openmemoryProvider.openaiApiKeyConfigured}
		<div class="muted" style="font-size:12px;margin-top:0.2rem">
			API key already configured. Leave blank to keep current key.
		</div>
	{/if}
</div>

<details
	class="channel-section"
	style="border:1px solid var(--border);border-radius:8px;padding:0.5rem 0.8rem;margin-top:0.8rem"
>
	<summary style="cursor:pointer;font-weight:600;font-size:14px;padding:0.3rem 0;user-select:none"
		>Advanced: Service Connections & Small Model</summary
	>
	<div
		class="sec-box"
		style="border-color:var(--yellow);background:rgba(234,179,8,0.1);margin-top:0.5rem"
	>
		<strong>Warning:</strong> Changing these values after setup is complete may affect your data and
		workflows.
	</div>
	<label style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Memory service address</label>
	<input
		id="wiz-svc-openmemory"
		placeholder="Leave blank to use built-in"
		value={serviceInstances.openmemory || ''}
	/>
	<label style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Database connection</label>
	<input
		id="wiz-svc-psql"
		placeholder="Leave blank to use built-in"
		value={serviceInstances.psql || ''}
	/>
	<label style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Search service address</label>
	<input
		id="wiz-svc-qdrant"
		placeholder="Leave blank to use built-in"
		value={serviceInstances.qdrant || ''}
	/>
	<hr style="margin:1rem 0;border:none;border-top:1px solid var(--border)" />
	<p style="margin:0.5rem 0"><strong>Small / Fast Model for OpenCode</strong></p>
	<div class="muted" style="font-size:12px;margin-bottom:0.5rem">
		Configure a lightweight model for system tasks like summaries and title generation.
	</div>
	<label style="display:block;margin:0.5rem 0 0.2rem;font-size:13px"
		>Small model endpoint (OpenAI-compatible)</label
	>
	<input
		id="wiz-small-model-endpoint"
		placeholder="http://localhost:11434/v1"
		value={smallModelProvider.endpoint || ''}
	/>
	<label style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Small model API key</label>
	<input
		id="wiz-small-model-key"
		type="password"
		placeholder="sk-... (leave blank if not required)"
		value=""
	/>
	{#if smallModelProvider.apiKeyConfigured}
		<div class="muted" style="font-size:12px;margin-top:0.2rem">
			API key already configured. Leave blank to keep current key.
		</div>
	{:else}
		<div class="muted" style="font-size:12px;margin-top:0.2rem">
			Leave blank if your endpoint does not require authentication (e.g. local Ollama).
		</div>
	{/if}
	<label style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Small model name</label>
	<input
		id="wiz-small-model-id"
		placeholder="ollama/tinyllama:latest"
		value={smallModelProvider.modelId || ''}
	/>
</details>
