<!--
  ProvidersPanel — Connections tab.

  Main view shows only Connected providers + an "Add provider" button.
  Add opens a searchable sheet of unconnected providers; selecting one
  opens ConnectSheet. "Import from host" pulls the host OpenCode config.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import EmptyState from '$lib/components/common/EmptyState.svelte';
	import { buildHeaders } from '$lib/api.js';
	import type { AssistantCliToolStatus, ProviderPageState, ProviderView } from '$lib/types/providers.js';
	import AddProviderSheet from './AddProviderSheet.svelte';
	import ConnectSheet from './ConnectSheet.svelte';
	import IconServer from '$lib/components/icons/IconServer.svelte';
	import IconLock from '$lib/components/icons/IconLock.svelte';
	import CustomProviderForm from './CustomProviderForm.svelte';
	import HostImportModal from './HostImportModal.svelte';

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
	let activeSubtab = $state<'opencode' | 'codex' | 'claude' | 'copilot' | 'pi'>('opencode');
	let assistantCliTools = $state<AssistantCliToolStatus[]>([]);
	let assistantCliLoading = $state(true);
	let assistantCliWriting = $state<string | null>(null);

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

	async function loadAssistantCliTools(): Promise<void> {
		assistantCliLoading = true;
		try {
			const res = await fetch('/admin/providers/assistant-clis', { headers: buildHeaders() });
			if (res.ok) {
				const body = await res.json() as { tools?: AssistantCliToolStatus[] };
				assistantCliTools = body.tools ?? [];
			}
		} catch {
			assistantCliTools = [];
		} finally {
			assistantCliLoading = false;
		}
	}

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
		void loadAssistantCliTools();
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
				void loadAssistantCliTools();
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
	onMount(() => { void loadAssistantCliTools(); });

	function handleImportDone() {
		showImportSheet = false;
		void load();
		void loadHostStatus();
		void loadAssistantCliTools();
	}

	const assistantCliTabs = [
		{ id: 'codex', label: 'Codex' },
		{ id: 'claude', label: 'Claude Code' },
		{ id: 'copilot', label: 'Copilot' },
		{ id: 'pi', label: 'Pi' },
	] as const;

	const activeAssistantCliTool = $derived(
		assistantCliTools.find((tool) => tool.id === activeSubtab)
	);

	async function useExistingProvider(toolId: AssistantCliToolStatus['id'], providerId: string): Promise<void> {
		if (assistantCliWriting) return;
		assistantCliWriting = `${toolId}:${providerId}`;
		actionError = null;
		try {
			const res = await fetch(`/admin/providers/assistant-clis/${encodeURIComponent(toolId)}/use-provider`, {
				method: 'POST',
				headers: { ...buildHeaders(), 'content-type': 'application/json' },
				body: JSON.stringify({ providerId }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { message?: string };
				actionError = body.message ?? `Write failed (${res.status})`;
			} else {
				await loadAssistantCliTools();
			}
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'Request failed.';
		} finally {
			assistantCliWriting = null;
		}
	}
</script>

<div class="panel" role="tabpanel">
	<div class="panel-header">
		<div>
			<h2>Connections</h2>
			<p class="panel-subtitle">AI providers · model defaults</p>
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
			<button class="btn btn-secondary btn-sm" onclick={() => { void load(); void loadAssistantCliTools(); }} disabled={loading || assistantCliLoading}>
				{#if loading}<Spinner />{/if}
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
		<div class="connections-subtabs">
			<button
				type="button"
				class:active={activeSubtab === 'opencode'}
				onclick={() => { activeSubtab = 'opencode'; }}
			>
				OpenCode
			</button>
			{#each assistantCliTabs as tab (tab.id)}
				<button
					type="button"
					class:active={activeSubtab === tab.id}
					onclick={() => { activeSubtab = tab.id; }}
				>
					{tab.label}
				</button>
			{/each}
		</div>

		{#if activeSubtab === 'opencode'}
		{#if !pageState.available && !loading}
			<EmptyState>
				{#snippet icon()}
					<IconServer size={40} />
				{/snippet}
				<p>The assistant (OpenCode server) is not reachable. Start the assistant container and refresh.</p>
			</EmptyState>
		{:else if loading && pageState.providers.length === 0}
			<div class="loading-state">
				<Spinner />
				<span>Loading providers…</span>
			</div>
		{:else if connected.length === 0}
			<EmptyState>
				{#snippet icon()}
					<IconLock size={40} />
				{/snippet}
				<p>No providers connected yet.</p>
				<p class="empty-hint">Click <strong>Add provider</strong> above to sign in to one.</p>
			</EmptyState>
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

			<div class="providers-container">
				{#each connected as p (p.id)}
					<div class="provider-row">
						<div class="provider-id">
							<div>
								<span class="provider-name">{p.name}</span>
								<span class="provider-desc">{authBadge(p)}</span>
							</div>
						</div>
						<button
							class="btn btn-outline btn-sm"
							disabled={disconnectingId === p.id}
							onclick={() => void disconnect(p)}
						>
							{#if disconnectingId === p.id}<Spinner />{/if}
							Disconnect
						</button>
					</div>
				{/each}
			</div>
		{/if}
		{:else if assistantCliLoading}
			<div class="loading-state cli-loading-state">
				<Spinner />
				<span>Loading assistant CLI status…</span>
			</div>
		{:else if activeAssistantCliTool}
			<div class="assistant-cli-panel">
				<div class="assistant-cli-header">
					<div>
						<h3>{activeAssistantCliTool.name}</h3>
						<p>
							{activeAssistantCliTool.configured ? 'Detected existing config under the assistant home bind mount.' : 'No config file detected under the assistant home bind mount yet.'}
						</p>
					</div>
					<span class:configured={activeAssistantCliTool.configured} class="assistant-cli-status">
						{activeAssistantCliTool.configured ? 'Configured' : 'Not configured'}
					</span>
				</div>

				<div class="assistant-cli-paths">
					{#each activeAssistantCliTool.configPaths as path (path)}
						<code>{path}</code>
					{/each}
				</div>

				{#if activeAssistantCliTool.availableProviderMappings.length > 0}
					<p class="assistant-cli-copy">
						Use an existing OpenCode provider key to seed this CLI's local credential file.
					</p>
					<div class="assistant-cli-actions">
						{#each activeAssistantCliTool.availableProviderMappings as mapping (mapping.providerId)}
							<button
								type="button"
								class="btn btn-secondary btn-sm"
								disabled={assistantCliWriting !== null}
								onclick={() => void useExistingProvider(activeAssistantCliTool.id, mapping.providerId)}
							>
								{assistantCliWriting === `${activeAssistantCliTool.id}:${mapping.providerId}` ? 'Writing…' : `Use existing ${mapping.label}`}
							</button>
						{/each}
					</div>
				{:else}
					<p class="assistant-cli-copy assistant-cli-copy-muted">
						No direct OpenCode-provider file mapping is available for this tool yet.
					</p>
				{/if}
			</div>
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
		margin: var(--s-sp-3) var(--s-sp-5);
		justify-content: space-between;
	}

	.connections-subtabs {
		display: flex;
		gap: var(--s-sp-2);
		padding: var(--s-sp-3) var(--s-sp-5);
		border-bottom: var(--s-hair) solid var(--s-line);
		overflow-x: auto;
	}

	.connections-subtabs button {
		appearance: none;
		border: var(--s-hair) solid var(--s-line);
		background: none;
		color: var(--s-ink-3);
		border-radius: 2px;
		padding: 0.3em 0.9em;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		cursor: pointer;
		white-space: nowrap;
	}

	.connections-subtabs button.active {
		border-color: var(--s-seal);
		color: var(--s-seal);
	}

	.cli-loading-state {
		padding: var(--s-sp-5);
	}

	.assistant-cli-panel {
		padding: var(--s-sp-5);
		display: grid;
		gap: var(--s-sp-4);
	}

	.assistant-cli-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--s-sp-3);
	}

	.assistant-cli-header h3,
	.assistant-cli-header p,
	.assistant-cli-copy {
		margin: 0;
	}

	.assistant-cli-status {
		border-radius: 2px;
		padding: 0.2em 0.6em;
		border: var(--s-hair) solid var(--s-line);
		background: none;
		color: var(--s-ink-3);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
	}

	.assistant-cli-status.configured {
		color: var(--s-moss);
		border-color: var(--s-moss);
	}

	.assistant-cli-paths {
		display: grid;
		gap: var(--s-sp-2);
	}

	.assistant-cli-paths code {
		display: block;
		padding: var(--s-sp-2) var(--s-sp-3);
		border-radius: 2px;
		background: var(--s-paper-deep);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-2);
		overflow-wrap: anywhere;
	}

	.assistant-cli-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-sp-2);
	}

	.assistant-cli-copy-muted {
		color: var(--s-ink-3);
	}

	.providers-container {
		border: var(--s-hair) solid var(--s-line-soft);
		border-radius: 2px;
		overflow: hidden;
	}

	.providers-container {
		border: var(--s-hair) solid var(--s-line-soft);
		border-radius: 2px;
		overflow: hidden;
	}

	.provider-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-sp-4);
		padding: var(--s-sp-4) var(--s-sp-5);
		border-bottom: var(--s-hair) solid var(--s-line-soft);
	}

	.provider-row:last-child {
		border-bottom: none;
	}

	.model-defaults {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--s-sp-4);
		padding: var(--s-sp-4) var(--s-sp-5);
		border-bottom: var(--s-hair) solid var(--s-line);
		background: var(--s-paper-deep);
	}

	.model-field {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-1);
	}

	.model-field :global(.form-label) {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
	}

	.model-field :global(.form-input) {
		height: auto;
		border: var(--s-hair) solid var(--s-line);
		border-radius: 2px;
		background: none;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		padding: 0.4em 0.6em;
	}

	.model-field :global(.form-input:focus) {
		border-color: var(--s-seal);
	}

	.model-error {
		grid-column: 1 / -1;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-seal);
		margin: 0;
	}

	.provider-id {
		display: flex;
		align-items: flex-start;
		gap: var(--s-sp-2);
		min-width: 0;
	}

	.provider-id > div {
		display: flex;
		flex-direction: column;
	}

	.provider-name {
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		color: var(--s-ink);
		display: block;
		margin-bottom: var(--s-sp-1);
	}

	.provider-desc {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		display: block;
	}

	.empty-hint {
		color: var(--s-ink-3);
	}

	@media (max-width: 720px) {
		.model-defaults,
		.assistant-cli-header {
			grid-template-columns: 1fr;
			display: grid;
		}
	}

</style>
