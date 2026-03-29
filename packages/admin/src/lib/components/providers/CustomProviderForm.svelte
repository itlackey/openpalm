<script lang="ts">
	import { getAdminToken } from '$lib/auth.js';
	import { buildHeaders } from '$lib/api.js';
	import type { ProviderActionResult } from '$lib/types/providers.js';

	let {
		onaction
	}: {
		onaction?: (result: ProviderActionResult) => void;
	} = $props();

	function uid(prefix: string) {
		return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
	}

	type ModelRow = {
		rowId: string;
		id: string;
		name: string;
		contextLimit?: number;
		outputLimit?: number;
	};

	type HeaderRow = {
		rowId: string;
		key: string;
		value: string;
	};

	let modelRows = $state<ModelRow[]>([{ rowId: uid('model'), id: '', name: '' }]);
	let headerRows = $state<HeaderRow[]>([{ rowId: uid('header'), key: '', value: '' }]);
	let confirmOverwrite = $state(false);
	let submitting = $state(false);
	let feedback = $state<{ ok: boolean; message: string } | undefined>(undefined);

	const modelsJson = $derived(
		JSON.stringify(
			modelRows
				.filter((row) => row.id.trim().length > 0)
				.map((row) => ({
					id: row.id.trim(),
					name: row.name.trim(),
					contextLimit: typeof row.contextLimit === 'number' ? row.contextLimit : undefined,
					outputLimit: typeof row.outputLimit === 'number' ? row.outputLimit : undefined
				}))
		)
	);

	const headersJson = $derived(
		JSON.stringify(
			headerRows
				.filter((row) => row.key.trim().length > 0 && row.value.trim().length > 0)
				.map((row) => ({ key: row.key.trim(), value: row.value.trim() }))
		)
	);

	function addModelRow() {
		modelRows = [...modelRows, { rowId: uid('model'), id: '', name: '' }];
	}

	function addHeaderRow() {
		headerRows = [...headerRows, { rowId: uid('header'), key: '', value: '' }];
	}

	function removeModelRow(rowId: string) {
		const nextRows = modelRows.filter((row) => row.rowId !== rowId);
		modelRows = nextRows.length > 0 ? nextRows : [{ rowId: uid('model'), id: '', name: '' }];
	}

	function removeHeaderRow(rowId: string) {
		const nextRows = headerRows.filter((row) => row.rowId !== rowId);
		headerRows = nextRows.length > 0 ? nextRows : [{ rowId: uid('header'), key: '', value: '' }];
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const formData = new FormData(form);
		submitting = true;
		feedback = undefined;

		try {
			const token = getAdminToken() ?? '';
			const body: Record<string, unknown> = { action: 'saveCustomProvider' };
			for (const [key, value] of formData.entries()) {
				if (typeof value === 'string') body[key] = value;
			}
			body.modelsJson = modelsJson;
			body.headersJson = headersJson;
			body.confirmOverwrite = String(confirmOverwrite);

			const response = await fetch('/admin/providers/actions', {
				method: 'POST',
				headers: { ...buildHeaders(token), 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});

			const result = (await response.json()) as ProviderActionResult;
			feedback = { ok: result.ok === true, message: result.message ?? '' };
			onaction?.(result);
		} catch (err) {
			feedback = { ok: false, message: err instanceof Error ? err.message : 'Request failed.' };
		} finally {
			submitting = false;
		}
	}
</script>

<details class="custom-shell">
	<summary class="custom-summary">
		<div>
			<span class="custom-eyebrow">Custom provider</span>
			<h3 class="custom-title">Add an OpenAI-compatible provider</h3>
		</div>
		<span class="panel-desc">Use this when OpenCode does not already list your provider.</span>
	</summary>

	{#if feedback?.message}
		<div class="feedback" class:feedback--success={feedback.ok} class:feedback--error={!feedback.ok}>
			<span>{feedback.message}</span>
			<button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => { feedback = undefined; }}>x</button>
		</div>
	{/if}

	<form class="custom-form" autocomplete="off" onsubmit={handleSubmit}>
		<input type="hidden" name="modelsJson" value={modelsJson} />
		<input type="hidden" name="headersJson" value={headersJson} />
		<input type="hidden" name="confirmOverwrite" value={String(confirmOverwrite)} />

		<div class="two-up">
			<div class="form-field">
				<label class="form-label" for="custom-providerId">Provider ID</label>
				<input id="custom-providerId" name="providerId" autocomplete="off" class="form-input" placeholder="myprovider" required pattern="[a-z0-9_\-]+" />
				<span class="form-hint">Lowercase letters, numbers, hyphens, or underscores.</span>
			</div>

			<div class="form-field">
				<label class="form-label" for="custom-displayName">Display name</label>
				<input id="custom-displayName" name="displayName" autocomplete="off" class="form-input" placeholder="My AI Provider" required />
			</div>

			<div class="form-field">
				<label class="form-label" for="custom-baseURL">Base URL</label>
				<input id="custom-baseURL" name="baseURL" autocomplete="off" class="form-input" placeholder="https://api.myprovider.com/v1" required type="url" />
			</div>

			<div class="form-field">
				<label class="form-label" for="custom-apiKey">API key</label>
				<input id="custom-apiKey" name="apiKey" class="form-input" placeholder="API key" type="password" autocomplete="new-password" />
				<span class="form-hint">Optional. Leave empty if auth is managed via headers.</span>
			</div>
		</div>

		<label class="checkbox-card">
			<span class="checkbox-row">
				<input type="checkbox" bind:checked={confirmOverwrite} />
				<span>Overwrite an existing provider with this ID if one is already saved.</span>
			</span>
			<span class="form-hint">Leave unchecked to avoid replacing an existing custom provider by mistake.</span>
		</label>

		<section class="list-section">
			<div class="section-header">
				<div>
					<h4 class="section-title">Models <span class="form-hint">(optional)</span></h4>
					<p class="panel-desc">Leave empty to let OpenCode discover models automatically.</p>
				</div>
				<button type="button" class="btn btn-outline btn-sm" onclick={addModelRow}>Add model</button>
			</div>

			<div class="row-stack">
				{#each modelRows as row (row.rowId)}
					<div class="inline-row model-row">
						<input class="form-input" bind:value={row.id} placeholder="model-id" />
						<input class="form-input" bind:value={row.name} placeholder="Display name" />
						<input class="form-input" bind:value={row.contextLimit} type="number" min="1" step="1" placeholder="Context tokens" />
						<input class="form-input" bind:value={row.outputLimit} type="number" min="1" step="1" placeholder="Output tokens" />
						<button type="button" class="btn btn-ghost btn-sm" aria-label="Remove model" onclick={() => removeModelRow(row.rowId)}>
							Remove
						</button>
					</div>
				{/each}
			</div>
		</section>

		<section class="list-section">
			<div class="section-header">
				<div>
					<h4 class="section-title">Headers</h4>
					<p class="panel-desc">Optional custom headers sent with each request.</p>
				</div>
				<button type="button" class="btn btn-outline btn-sm" onclick={addHeaderRow}>Add header</button>
			</div>

			<div class="row-stack">
				{#each headerRows as row (row.rowId)}
					<div class="inline-row">
						<input class="form-input" bind:value={row.key} placeholder="Header-Name" />
						<input class="form-input" bind:value={row.value} placeholder="value" />
						<button type="button" class="btn btn-ghost btn-sm" aria-label="Remove header" onclick={() => removeHeaderRow(row.rowId)}>
							Remove
						</button>
					</div>
				{/each}
			</div>
		</section>

		<div class="submit-row">
			<button class="btn btn-primary" type="submit" disabled={submitting}>Create custom provider</button>
		</div>
	</form>
</details>

<style>
	.custom-shell {
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
	}

	.custom-summary {
		list-style: none;
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		align-items: center;
		cursor: pointer;
	}

	.custom-summary::-webkit-details-marker {
		display: none;
	}

	.custom-eyebrow {
		font-size: var(--text-xs);
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--color-text-tertiary);
		font-weight: var(--font-semibold);
	}

	.custom-title,
	.section-title {
		margin: var(--space-1) 0 0;
		font-size: var(--text-sm);
		font-weight: var(--font-semibold);
		color: var(--color-text);
	}

	.panel-desc,
	.form-hint {
		margin: var(--space-1) 0 0;
		color: var(--color-text-tertiary);
		font-size: var(--text-xs);
		line-height: 1.5;
	}

	.custom-form {
		display: grid;
		gap: var(--space-3);
		margin-top: var(--space-3);
	}

	.two-up {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	.form-field,
	.list-section,
	.row-stack,
	.checkbox-card {
		display: grid;
		gap: var(--space-1);
	}

	.checkbox-row {
		display: flex;
		gap: var(--space-2);
		align-items: flex-start;
		font-size: var(--text-sm);
	}

	.checkbox-card {
		padding: var(--space-3);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
	}

	.checkbox-row input[type="checkbox"] {
		width: 16px;
		height: 16px;
		margin-top: 2px;
		padding: 0;
	}

	.section-header,
	.inline-row,
	.submit-row {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		justify-content: space-between;
	}

	.inline-row {
		align-items: stretch;
	}

	.inline-row .form-input {
		flex: 1;
	}

	.model-row {
		display: grid;
		grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.2fr) minmax(0, 0.9fr) minmax(0, 0.9fr) auto;
		gap: var(--space-2);
	}

	.submit-row {
		justify-content: flex-start;
	}

	.feedback {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		font-size: var(--text-sm);
		border-radius: var(--radius-md);
		margin-top: var(--space-3);
	}

	.feedback span { flex: 1; }
	.feedback--success { background: var(--color-success-bg); color: var(--color-text); }
	.feedback--error { background: var(--color-danger-bg); color: var(--color-text); }

	.btn-dismiss {
		background: none;
		border: none;
		color: inherit;
		cursor: pointer;
		opacity: 0.6;
		font-size: var(--text-sm);
	}
	.btn-dismiss:hover { opacity: 1; }

	@media (max-width: 860px) {
		.custom-summary,
		.section-header,
		.inline-row,
		.two-up {
			display: grid;
			grid-template-columns: 1fr;
		}
	}
</style>
