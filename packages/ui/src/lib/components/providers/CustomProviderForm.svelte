<!--
  CustomProviderForm — sheet for registering a custom OpenAI-compatible
  provider. 4 fields: ID, display name, base URL, API key (optional).
  Models auto-discovered on first connection.
-->
<script lang="ts">
	import Spinner from '@openpalm/ui-kit/components/common/Spinner.svelte';
	import FormField from '@openpalm/ui-kit/components/common/FormField.svelte';
	import Drawer from '@openpalm/ui-kit/components/common/Drawer.svelte';
	import { registerCustomProvider } from '$lib/api/providers.js';
	import { toMessage } from '$lib/api/errors.js';
	import type { ProviderActionResult } from '$lib/types/providers.js';

	let {
		onaction,
		onclose
	}: {
		onaction?: (result: ProviderActionResult) => void;
		onclose?: () => void;
	} = $props();

	let id = $state('');
	let displayName = $state('');
	let baseURL = $state('');
	let apiKey = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);

	async function submit() {
		const trimmedId = id.trim();
		const trimmedName = displayName.trim();
		const trimmedURL = baseURL.trim();

		if (!trimmedId || !trimmedName || !trimmedURL) {
			error = 'ID, display name, and base URL are required.';
			return;
		}

		submitting = true;
		error = null;
		try {
			const result = await registerCustomProvider(trimmedId, {
				displayName: trimmedName,
				baseURL: trimmedURL,
				apiKey: apiKey.trim() || undefined,
			});
			onaction?.(result);
		} catch (err) {
			error = toMessage(err, 'Request failed.');
		} finally {
			submitting = false;
		}
	}

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !submitting) void submit();
	}
</script>

<Drawer open={true} title="Add custom provider" onClose={() => onclose?.()}>
		<p class="field-hint">
			Register an OpenAI-compatible provider by base URL. Models are auto-discovered on first connection.
		</p>

		{#if error}
			<div class="feedback feedback--error"><span>{error}</span></div>
		{/if}

		<div class="form-stack">
			<FormField label="Provider ID" for="custom-id">
				<input
					id="custom-id"
					type="text"
					class="form-input"
					placeholder="my-provider"
					bind:value={id}
					disabled={submitting}
					onkeydown={handleKey}
					autocomplete="off"
				/>
			</FormField>

			<FormField label="Display name" for="custom-name">
				<input
					id="custom-name"
					type="text"
					class="form-input"
					placeholder="My Provider"
					bind:value={displayName}
					disabled={submitting}
					onkeydown={handleKey}
					autocomplete="off"
				/>
			</FormField>

			<FormField label="Base URL" for="custom-url">
				<input
					id="custom-url"
					type="url"
					class="form-input"
					placeholder="https://example.com/v1"
					bind:value={baseURL}
					disabled={submitting}
					onkeydown={handleKey}
					autocomplete="off"
				/>
			</FormField>

			<div class="form-field">
				<label class="form-label" for="custom-key">API key <span class="optional">(optional)</span></label>
				<input
					id="custom-key"
					type="password"
					class="form-input"
					placeholder="API key"
					bind:value={apiKey}
					disabled={submitting}
					onkeydown={handleKey}
					autocomplete="off"
				/>
			</div>
		</div>
	{#snippet footer()}
		<button type="button" class="btn btn-primary" disabled={submitting} onclick={() => void submit()}>
			{#if submitting}<Spinner />{/if}
			Continue
		</button>
	{/snippet}
</Drawer>

<style>
	.form-stack {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-4);
	}

	.optional {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-3);
	}

	:global(.form-field .form-input) {
		height: auto;
		border: var(--s-hair) solid var(--s-line);
		border-radius: 2px;
		background: none;
		font-family: var(--s-font-mono);
		padding: 0.4em 0.6em;
		font-size: var(--s-type-deed);
	}

	:global(.form-field .form-input:focus) {
		border-color: var(--s-seal);
		box-shadow: none;
	}
</style>
