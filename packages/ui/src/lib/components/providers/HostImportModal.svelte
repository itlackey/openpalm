<!--
  HostImportModal — sheet showing detected host OpenCode counts; runs
  POST /admin/providers/import-host on confirm.
-->
<script lang="ts">
	import Spinner from '$lib/components/common/Spinner.svelte';
	import Drawer from '$lib/components/common/Drawer.svelte';
	import { buildHeaders } from '$lib/api.js';

	let {
		providerCount,
		credentialCount,
		configPath,
		authPath,
		onimported,
		oncancel
	}: {
		providerCount: number;
		credentialCount: number;
		configPath: string | null;
		authPath: string | null;
		onimported?: () => void;
		oncancel?: () => void;
	} = $props();

	let importing = $state(false);
	let error = $state<string | null>(null);

	type ImportResult = {
		ok: boolean;
		imported: { providers: number; credentials: number };
		conflicts: string[];
		livePushed?: number;
		livePushFailed?: string[];
	};

	let result = $state<ImportResult | null>(null);

	async function runImport() {
		importing = true;
		error = null;
		try {
			const res = await fetch('/admin/providers/import-host', {
				method: 'POST',
				headers: buildHeaders()
			});
			const body = (await res.json()) as ImportResult;
			if (!res.ok) {
				error = (body as unknown as { message?: string }).message ?? `Import failed (${res.status})`;
				return;
			}
			result = body;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Import failed.';
		} finally {
			importing = false;
		}
	}
</script>

<Drawer open={true} title="Import from host OpenCode" onClose={() => (result ? onimported?.() : oncancel?.())}>
		{#if result}
			<div class="feedback feedback--success">
				<span>Import complete.</span>
			</div>
			<ul class="result-list">
				<li>Providers imported: <strong>{result.imported.providers}</strong></li>
				<li>Credentials imported: <strong>{result.imported.credentials}</strong></li>
				{#if result.livePushed !== undefined}
					<li>Activated in OpenCode: <strong>{result.livePushed}</strong></li>
				{/if}
				{#if result.conflicts.length > 0}
					<li>Skipped (already configured): <strong>{result.conflicts.join(', ')}</strong></li>
				{/if}
				{#if result.livePushFailed && result.livePushFailed.length > 0}
					<li>
						<span class="muted">
							Live update failed for: {result.livePushFailed.join(', ')}.
							These will activate on next OpenCode restart.
						</span>
					</li>
				{/if}
			</ul>
		{:else}
			<p class="field-hint">We found an OpenCode installation on this host:</p>
			<ul class="result-list">
				{#if configPath}
					<li>
						<code>{configPath}</code>
						<span class="muted">({providerCount} provider{providerCount !== 1 ? 's' : ''})</span>
					</li>
				{/if}
				{#if authPath}
					<li>
						<code>{authPath}</code>
						<span class="muted">({credentialCount} credential{credentialCount !== 1 ? 's' : ''})</span>
					</li>
				{/if}
			</ul>
			<p class="field-hint">
				Importing will copy provider settings and stored credentials into OP_HOME and
				activate them in the running assistant. Existing OP_HOME credentials are
				preserved on conflict.
			</p>
			{#if error}
				<div class="feedback feedback--error"><span>{error}</span></div>
			{/if}
		{/if}
	{#snippet footer()}
		{#if result}
			<button type="button" class="btn btn-primary" onclick={onimported}>Done</button>
		{:else}
			<button
				type="button"
				class="btn btn-primary"
				disabled={importing}
				onclick={() => void runImport()}
			>
				{#if importing}<Spinner />{/if}
				Import
			</button>
		{/if}
	{/snippet}
</Drawer>

<style>
	.result-list {
		list-style: disc;
		padding-left: var(--space-5);
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin: 0 0 var(--space-3);
	}

	.result-list li {
		font-size: var(--text-sm);
		color: var(--color-text);
	}

	.result-list code {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
		background: var(--color-bg-tertiary);
		padding: 1px 6px;
		border-radius: var(--radius-sm);
	}

	.muted {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
		margin-left: var(--space-2);
	}
</style>
