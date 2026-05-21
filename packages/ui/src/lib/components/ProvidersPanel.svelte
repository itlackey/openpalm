<!--
  ProvidersPanel — Connections tab.

  Main view shows only Connected providers + an "Add provider" button.
  Add opens a searchable sheet of unconnected providers; selecting one
  opens ConnectSheet. "Import from host" pulls the host OpenCode config.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { buildHeaders } from '$lib/api.js';
	import type { ProviderPageState, ProviderView } from '$lib/types/providers.js';
	import AddProviderSheet from './providers/AddProviderSheet.svelte';
	import ConnectSheet from './providers/ConnectSheet.svelte';
	import CustomProviderForm from './providers/CustomProviderForm.svelte';
	import HostImportModal from './providers/HostImportModal.svelte';

	let pageState = $state<ProviderPageState>({
		available: false,
		providers: [],
		defaultModels: {},
		allowlistActive: false,
		providerCountLabel: '',
		stats: { total: 0, connected: 0, configured: 0, disabled: 0 }
	});
	let loading = $state(true);
	let actionError = $state<string | null>(null);

	async function load(): Promise<void> {
		loading = true;
		try {
			const res = await fetch('/admin/providers', { headers: buildHeaders() });
			if (res.ok) {
				pageState = (await res.json()) as ProviderPageState;
				// Sync the model dropdowns to whatever the server says — only at
				// load-time, never via a reactive $effect (which would stomp
				// user-in-progress edits if a refresh raced a select change).
				mainModelChoice = pageState.currentModel ?? '';
				smallModelChoice = pageState.currentSmallModel ?? '';
			}
		} catch {
			/* offline */
		} finally {
			loading = false;
		}
	}

	onMount(() => { void load(); });

	const connected = $derived(pageState.providers.filter((p) => p.connected));
	const unconnected = $derived(pageState.providers.filter((p) => !p.connected));

	// Default model + small model bound to `<select>` values. Empty string =
	// "use OpenCode's own default" (unsets the field in opencode.json).
	// These are synced to `pageState.currentModel` inside `load()`, not via
	// `$effect`, so a refresh in flight can't stomp a user-in-progress edit.
	let mainModelChoice = $state('');
	let smallModelChoice = $state('');
	let modelSaveError = $state<string | null>(null);

	async function saveModel(target: 'model' | 'small_model', value: string) {
		modelSaveError = null;
		try {
			const res = await fetch('/admin/opencode/model', {
				method: 'POST',
				headers: { ...buildHeaders(), 'content-type': 'application/json' },
				body: JSON.stringify({ [target]: value || null }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { message?: string };
				modelSaveError = body.message ?? `Save failed (${res.status})`;
			}
		} catch (err) {
			modelSaveError = err instanceof Error ? err.message : 'Request failed.';
		}
	}

	// Sheets
	let showAddSheet = $state(false);
	let connectProvider = $state<ProviderView | null>(null);
	let showCustomForm = $state(false);
	let disconnectingId = $state<string | null>(null);

	const BADGE_LABEL: Record<NonNullable<ProviderView['credentialType']>, string> = {
		env: 'env',
		api: 'api key',
		oauth: 'oauth',
		config: 'config',
		custom: 'custom',
	};
	function authBadge(p: ProviderView): string {
		return p.credentialType ? BADGE_LABEL[p.credentialType] : '';
	}

	function pickProvider(p: ProviderView) {
		showAddSheet = false;
		connectProvider = p;
	}

	function pickCustom() {
		showAddSheet = false;
		showCustomForm = true;
	}

	function handleAfterAction() {
		connectProvider = null;
		showCustomForm = false;
		void load();
	}

	async function disconnect(p: ProviderView) {
		if (!confirm(`Disconnect ${p.name}? Stored credentials will be removed.`)) return;
		disconnectingId = p.id;
		actionError = null;
		try {
			const res = await fetch(
				`/admin/opencode/providers/${encodeURIComponent(p.id)}/auth`,
				{ method: 'DELETE', headers: buildHeaders() }
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { message?: string };
				actionError = body.message ?? `Disconnect failed (${res.status})`;
			} else {
				void load();
			}
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'Request failed.';
		} finally {
			disconnectingId = null;
		}
	}

	// Host import
	type HostStatus = {
		detected: boolean;
		providerCount: number;
		credentialCount: number;
		configPath: string | null;
		authPath: string | null;
	};
	let hostStatus = $state<HostStatus | null>(null);
	let showImportSheet = $state(false);

	async function loadHostStatus(): Promise<void> {
		try {
			const res = await fetch('/admin/providers/host-status', { headers: buildHeaders() });
			if (res.ok) hostStatus = (await res.json()) as HostStatus;
		} catch {
			/* non-critical */
		}
	}

	onMount(() => { void loadHostStatus(); });

	function handleImportDone() {
		showImportSheet = false;
		void load();
		void loadHostStatus();
	}
</script>

<div class="panel" role="tabpanel">
	<div class="panel-header">
		<div>
			<h2>Connections</h2>
			<p class="panel-subtitle">
				Sign in to AI providers. Credentials are stored in OpenCode's auth.json.
			</p>
		</div>
		<div class="panel-header-actions">
			<button
				type="button"
				class="btn btn-secondary btn-sm"
				disabled={!hostStatus?.detected}
				onclick={() => { showImportSheet = true; }}
				title={hostStatus?.detected
					? `Import ${hostStatus.providerCount} providers from host OpenCode`
					: 'No host OpenCode installation detected'}
			>
				Import from host
			</button>
			<button
				type="button"
				class="btn btn-primary btn-sm"
				onclick={() => { showAddSheet = true; }}
			>
				Add provider
			</button>
			<button class="btn btn-secondary btn-sm" onclick={() => void load()} disabled={loading}>
				{#if loading}<span class="spinner"></span>{/if}
				Refresh
			</button>
		</div>
	</div>

	{#if actionError}
		<div class="feedback feedback--error inline">
			<span>{actionError}</span>
			<button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => actionError = null}>×</button>
		</div>
	{/if}

	<div class="panel-body panel-body--flush">
		{#if !pageState.available && !loading}
			<div class="empty-state">
				<p>The assistant (OpenCode server) is not reachable. Start the assistant container and refresh.</p>
				{#if pageState.error}<p class="error-detail">{pageState.error}</p>{/if}
			</div>
		{:else if loading && pageState.providers.length === 0}
			<div class="loading-state">
				<span class="spinner"></span>
				<span>Loading providers…</span>
			</div>
		{:else if connected.length === 0}
			<div class="empty-state">
				<p>No providers connected yet.</p>
				<p class="empty-hint">Click <strong>Add provider</strong> above to sign in to one.</p>
			</div>
		{:else}
			<!-- OpenCode default + small model. Saved to opencode.json — used
			     when the chat doesn't specify a model per-request. -->
			<div class="model-defaults">
				<div class="model-field">
					<label class="form-label" for="default-model">Default model</label>
					<select
						id="default-model"
						class="form-input"
						bind:value={mainModelChoice}
						onchange={(e) => void saveModel('model', (e.currentTarget as HTMLSelectElement).value)}
					>
						<option value="">— OpenCode default —</option>
						{#each connected as p (p.id)}
							{#if p.models.length > 0}
								<optgroup label={p.name}>
									{#each p.models as m (m.id)}
										<option value="{p.id}/{m.id}">{m.name || m.id}</option>
									{/each}
								</optgroup>
							{/if}
						{/each}
					</select>
				</div>
				<div class="model-field">
					<label class="form-label" for="small-model">Small model</label>
					<select
						id="small-model"
						class="form-input"
						bind:value={smallModelChoice}
						onchange={(e) => void saveModel('small_model', (e.currentTarget as HTMLSelectElement).value)}
					>
						<option value="">— OpenCode default —</option>
						{#each connected as p (p.id)}
							{#if p.models.length > 0}
								<optgroup label={p.name}>
									{#each p.models as m (m.id)}
										<option value="{p.id}/{m.id}">{m.name || m.id}</option>
									{/each}
								</optgroup>
							{/if}
						{/each}
					</select>
				</div>
				{#if modelSaveError}<p class="model-error">{modelSaveError}</p>{/if}
			</div>

			{#each connected as p (p.id)}
				<div class="provider-row">
					<div class="provider-id">
						<span class="provider-name">{p.name}</span>
						<span class="badge badge-connected">{authBadge(p)}</span>
					</div>
					<button
						class="btn btn-outline btn-sm"
						disabled={disconnectingId === p.id}
						onclick={() => void disconnect(p)}
					>
						{#if disconnectingId === p.id}<span class="spinner"></span>{/if}
						Disconnect
					</button>
				</div>
			{/each}
		{/if}
	</div>
</div>

{#if showAddSheet}
	<AddProviderSheet
		providers={unconnected}
		onselect={pickProvider}
		oncustom={pickCustom}
		onclose={() => { showAddSheet = false; }}
	/>
{/if}

{#if connectProvider}
	<ConnectSheet
		provider={connectProvider}
		onaction={handleAfterAction}
		onclose={() => { connectProvider = null; }}
	/>
{/if}

{#if showCustomForm}
	<CustomProviderForm
		onaction={handleAfterAction}
		onclose={() => { showCustomForm = false; }}
	/>
{/if}

{#if showImportSheet && hostStatus}
	<HostImportModal
		providerCount={hostStatus.providerCount}
		credentialCount={hostStatus.credentialCount}
		configPath={hostStatus.configPath}
		authPath={hostStatus.authPath}
		onimported={handleImportDone}
		oncancel={() => { showImportSheet = false; }}
	/>
{/if}

<style>
	.feedback.inline {
		margin: var(--space-3) var(--space-5);
		justify-content: space-between;
	}

	.provider-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-5);
		border-bottom: 1px solid var(--color-bg-tertiary);
	}

	.model-defaults {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-4);
		padding: var(--space-4) var(--space-5);
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
	}

	.model-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.model-error {
		grid-column: 1 / -1;
		font-size: var(--text-xs);
		color: var(--color-danger);
		margin: 0;
	}

	.provider-id {
		flex: 1;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	.provider-name {
		font-size: var(--text-sm);
		font-weight: var(--font-medium);
		color: var(--color-text);
	}

	.empty-hint {
		color: var(--color-text-tertiary);
	}

	.error-detail {
		font-size: var(--text-xs);
		color: var(--color-danger);
	}
</style>
