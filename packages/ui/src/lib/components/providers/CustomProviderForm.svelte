<!--
  CustomProviderForm — sheet for registering a custom OpenAI-compatible
  provider. 4 fields: ID, display name, base URL, API key (optional).
  Models auto-discovered on first connection.
-->
<script lang="ts">
	import Spinner from '$lib/components/common/Spinner.svelte';
	import FormField from '$lib/components/common/FormField.svelte';
	import Drawer from '$lib/components/common/Drawer.svelte';
	import { buildHeaders } from '$lib/api.js';
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
			const res = await fetch(`/admin/providers/${encodeURIComponent(trimmedId)}`, {
				method: 'PATCH',
				headers: { ...buildHeaders(), 'content-type': 'application/json' },
				body: JSON.stringify({
					kind: 'register-custom',
					displayName: trimmedName,
					baseURL: trimmedURL,
					apiKey: apiKey.trim() || undefined,
					modelsJson: '[]',
					headersJson: '[]',
					confirmOverwrite: 'false',
				})
			});
			const result = (await res.json()) as ProviderActionResult;
			if (!res.ok || result.ok === false) {
				error = result.message ?? 'Registration failed.';
				return;
			}
			onaction?.(result);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Request failed.';
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
		gap: var(--space-4);
	}

	.optional {
		font-weight: var(--font-medium);
		color: var(--color-text-tertiary);
		font-size: var(--text-xs);
	}
</style>
