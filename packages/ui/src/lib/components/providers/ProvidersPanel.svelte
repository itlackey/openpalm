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
	import {
		fetchProviders,
		saveOpencodeModel,
		disconnectProvider,
		fetchHostStatus,
		type ProviderHostStatus,
	} from '$lib/api/providers.js';
	import { fetchSecretFile } from '$lib/api/secrets.js';
	import { toMessage } from '$lib/api/errors.js';
	import type { ProviderPageState, ProviderView } from '$lib/types/providers.js';
	import AddProviderSheet from './AddProviderSheet.svelte';
	import ConnectSheet from './ConnectSheet.svelte';
	import IconServer from '$lib/components/icons/IconServer.svelte';
	import IconLock from '$lib/components/icons/IconLock.svelte';
	import CustomProviderForm from './CustomProviderForm.svelte';
	import HostImportModal from './HostImportModal.svelte';
	import { createFocusTrap, handleTrapKeydown } from '$lib/actions/focus-trap.js';

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
			pageState = await fetchProviders();
			// Sync the model dropdowns to whatever the server says — only at
			// load-time, never via a reactive $effect (which would stomp
			// user-in-progress edits if a refresh raced a select change).
			mainModelChoice = pageState.currentModel ?? '';
			smallModelChoice = pageState.currentSmallModel ?? '';
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
			await saveOpencodeModel(target, value);
		} catch (err) {
			modelSaveError = toMessage(err, 'Request failed.');
		}
	}

	// Sheets
	let showAddSheet = $state(false);
	let connectProvider = $state<ProviderView | null>(null);
	let showCustomForm = $state(false);
	let disconnectingId = $state<string | null>(null);
	// Disconnect-confirmation prompt (in-DOM, mirrors RecoveryTab's prune prompt —
	// testable and consistent with the app's own dialog components, unlike the
	// untestable native confirm()).
	let pendingDisconnect = $state<ProviderView | null>(null);
	const manageDisconnectFocus = createFocusTrap({
		initialFocus: '.confirm-actions',
		deferRestore: true,
	});

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

	function requestDisconnect(p: ProviderView) {
		if (disconnectingId) return;
		pendingDisconnect = p;
	}

	function cancelDisconnect() {
		pendingDisconnect = null;
	}

	async function confirmDisconnect() {
		const p = pendingDisconnect;
		if (!p || disconnectingId) return;
		disconnectingId = p.id;
		actionError = null;
		try {
			await disconnectProvider(p.id);
			pendingDisconnect = null;
			void load();
		} catch (err) {
			actionError = toMessage(err, 'Request failed.');
		} finally {
			disconnectingId = null;
		}
	}

	// Host import
	let hostStatus = $state<ProviderHostStatus | null>(null);
	let showImportSheet = $state(false);

	async function loadHostStatus(): Promise<void> {
		try {
			hostStatus = await fetchHostStatus();
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

	// ── OpenAI-compatible edge API key (op_api_key) ─────────────────────────
	// The credential end users paste into OpenAI-compatible clients to reach the
	// guardian's OpenAI/Anthropic-compatible edge. Read-only, revealed on demand
	// through the existing secret-file endpoint; the value is NEVER logged.
	let apiKey = $state<string | null>(null);
	let apiKeyLoading = $state(false);
	let apiKeyError = $state('');
	let apiKeyCopied = $state(false);

	async function revealApiKey(): Promise<void> {
		apiKeyLoading = true;
		apiKeyError = '';
		try {
			const { value } = await fetchSecretFile('op_api_key');
			apiKey = value.trim();
		} catch (err) {
			apiKeyError = toMessage(err, 'Could not read the API key.');
		} finally {
			apiKeyLoading = false;
		}
	}

	function hideApiKey(): void {
		apiKey = null;
		apiKeyCopied = false;
	}

	async function copyApiKey(): Promise<void> {
		if (!apiKey) return;
		try {
			await navigator.clipboard.writeText(apiKey);
			apiKeyCopied = true;
		} catch {
			apiKeyError = 'Copy failed — select the value and copy manually.';
		}
	}
</script>

<div
	class="panel"
	role="tabpanel"
	inert={showAddSheet || connectProvider !== null || showCustomForm || pendingDisconnect !== null || showImportSheet}
>
	<div class="panel-header">
		<div>
			<h2>AI Providers</h2>
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
				id="add-provider-trigger"
				type="button"
				class="btn btn-primary btn-sm"
				onclick={() => { showAddSheet = true; }}
			>
				Add provider
			</button>
			<button class="btn btn-secondary btn-sm" onclick={() => { void load(); }} disabled={loading}>
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
		<section class="api-edge" aria-labelledby="api-edge-title">
			<div class="api-edge-head">
				<div>
					<h3 id="api-edge-title">OpenAI-compatible API</h3>
					<p>Point any OpenAI- or Anthropic-compatible client at this host and paste the key below as its API key.</p>
				</div>
			</div>
			<p class="api-edge-endpoint">Base URL <code>http://&lt;your-host&gt;:3821/v1</code></p>
			{#if apiKey === null}
				<button type="button" class="btn btn-secondary btn-sm" onclick={() => void revealApiKey()} disabled={apiKeyLoading}>
					{#if apiKeyLoading}<Spinner />{/if}
					Reveal API key
				</button>
			{:else}
				<div class="api-edge-key">
					<input type="text" readonly class="form-input" value={apiKey} aria-label="OpenAI-compatible API key" />
					<button type="button" class="btn btn-secondary btn-sm" onclick={() => void copyApiKey()}>
						{apiKeyCopied ? 'Copied' : 'Copy'}
					</button>
					<button type="button" class="btn btn-outline btn-sm" onclick={hideApiKey}>Hide</button>
				</div>
			{/if}
			{#if apiKeyError}<p class="api-edge-error">{apiKeyError}</p>{/if}
		</section>

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
							onclick={() => requestDisconnect(p)}
						>
							{#if disconnectingId === p.id}<Spinner />{/if}
							Disconnect
						</button>
					</div>
				{/each}
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
		returnFocus={() => document.getElementById('add-provider-trigger')}
	/>
{/if}

{#if connectProvider}
	<ConnectSheet
		provider={connectProvider}
		onaction={handleAfterAction}
		onclose={() => { connectProvider = null; }}
		returnFocus={() => document.getElementById('add-provider-trigger')}
	/>
{/if}

{#if showCustomForm}
	<CustomProviderForm
		onaction={handleAfterAction}
		onclose={() => { showCustomForm = false; }}
		returnFocus={() => document.getElementById('add-provider-trigger')}
	/>
{/if}

{#if pendingDisconnect}
	<div
		class="confirm-prompt"
		role="alertdialog"
		aria-modal="true"
		aria-label="Confirm disconnect provider"
		tabindex="-1"
		onkeydown={(event) => handleTrapKeydown(event, cancelDisconnect)}
		{@attach manageDisconnectFocus}
	>
		<p class="confirm-prompt-title">Disconnect provider?</p>
		<p>Disconnect {pendingDisconnect.name}? Stored credentials will be removed.</p>
		<div class="confirm-actions">
			<button class="btn btn-sm btn-danger" onclick={() => void confirmDisconnect()} disabled={disconnectingId !== null}>
				{#if disconnectingId !== null}<Spinner /> Disconnecting…{:else}Disconnect{/if}
			</button>
			<button class="btn btn-sm btn-secondary" onclick={cancelDisconnect} disabled={disconnectingId !== null}>Cancel</button>
		</div>
	</div>
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

	.api-edge {
		display: grid;
		gap: var(--s-sp-3);
		padding: var(--s-sp-4) var(--s-sp-5);
		border-bottom: var(--s-hair) solid var(--s-line);
		background: var(--s-paper-deep);
	}

	.api-edge-head h3 {
		margin: 0 0 var(--s-sp-1) 0;
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		color: var(--s-ink);
	}

	.api-edge-head p,
	.api-edge-endpoint {
		margin: 0;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-3);
	}

	.api-edge-endpoint code,
	.api-edge-key .form-input {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
	}

	.api-edge-key {
		display: flex;
		gap: var(--s-sp-2);
		align-items: center;
		flex-wrap: wrap;
	}

	.api-edge-key .form-input {
		flex: 1 1 16rem;
		min-width: 0;
		border: var(--s-hair) solid var(--s-line);
		border-radius: 2px;
		background: none;
		padding: 0.4em 0.6em;
	}

	.api-edge-error {
		margin: 0;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-seal);
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

	.confirm-prompt {
		margin: var(--s-sp-3) var(--s-sp-5);
		padding: var(--s-sp-3);
		border: var(--s-hair) solid var(--s-seal);
		border-radius: 2px;
	}
	.confirm-prompt-title {
		margin: 0 0 var(--s-sp-1) 0;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-seal);
	}
	.confirm-prompt p {
		margin: 0 0 var(--s-sp-2) 0;
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		color: var(--s-ink);
	}
	.confirm-actions {
		display: flex;
		gap: var(--s-sp-2);
	}

	@media (max-width: 720px) {
		.model-defaults {
			grid-template-columns: 1fr;
			display: grid;
		}
	}

</style>
