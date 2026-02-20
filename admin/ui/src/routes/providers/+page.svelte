<script lang="ts">
	import { apiGet, apiPost } from '$lib/api';
	import { showToast } from '$lib/stores/toast';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import type { ProviderConnection, ModelAssignment } from '$lib/types';

	type ProvidersResponse = {
		providers: ProviderConnection[];
		assignments: Record<ModelAssignment, { providerId: string; modelId: string }>;
	};

	type ProviderMutationResponse = {
		ok: boolean;
		provider: ProviderConnection;
	};

	type ModelsResponse = {
		ok: boolean;
		models: { id: string; object?: string }[];
	};

	type AssignResponse = {
		ok: boolean;
		assignments: Record<ModelAssignment, { providerId: string; modelId: string }>;
	};

	// --- State ---
	let loading = $state(true);
	let providers = $state<ProviderConnection[]>([]);
	let assignments = $state<Record<ModelAssignment, { providerId: string; modelId: string }>>({
		small: { providerId: '', modelId: '' },
		openmemory: { providerId: '', modelId: '' }
	});

	// Add form
	let addName = $state('');
	let addUrl = $state('');
	let addApiKey = $state('');
	let adding = $state(false);

	// Edit state
	let editingId = $state<string | null>(null);
	let editName = $state('');
	let editUrl = $state('');
	let editApiKey = $state('');
	let saving = $state(false);

	// Delete state
	let confirmDeleteId = $state<string | null>(null);
	let deleting = $state(false);

	// Models state
	let modelsByProvider = $state<Record<string, { id: string; object?: string }[]>>({});
	let fetchingModels = $state<Record<string, boolean>>({});

	// Assignment form state
	let assignSmallProvider = $state('');
	let assignSmallModel = $state('');
	let assigningSmall = $state(false);
	let assignOpenMemProvider = $state('');
	let assignOpenMemModel = $state('');
	let assigningOpenMem = $state(false);

	// --- Derived ---
	let assignSmallModels = $derived(
		assignSmallProvider ? (modelsByProvider[assignSmallProvider] ?? []) : []
	);

	let assignOpenMemModels = $derived(
		assignOpenMemProvider ? (modelsByProvider[assignOpenMemProvider] ?? []) : []
	);

	// --- Load data ---
	$effect(() => {
		loadProviders();
	});

	async function loadProviders() {
		loading = true;
		const res = await apiGet<ProvidersResponse>('/admin/providers');
		if (res.ok && res.data) {
			providers = res.data.providers ?? [];
			if (res.data.assignments) {
				assignments = res.data.assignments;
				// Prefill assignment dropdowns from current assignments
				if (assignments.small?.providerId) {
					assignSmallProvider = assignments.small.providerId;
					assignSmallModel = assignments.small.modelId ?? '';
				}
				if (assignments.openmemory?.providerId) {
					assignOpenMemProvider = assignments.openmemory.providerId;
					assignOpenMemModel = assignments.openmemory.modelId ?? '';
				}
			}
		} else {
			showToast('Failed to load providers', 'error');
		}
		loading = false;
	}

	// --- Add provider ---
	async function addProvider() {
		if (!addName.trim()) {
			showToast('Provider name is required', 'error');
			return;
		}
		adding = true;
		const body: Record<string, string> = { name: addName.trim() };
		if (addUrl.trim()) body.url = addUrl.trim();
		if (addApiKey.trim()) body.apiKey = addApiKey.trim();

		const res = await apiPost<ProviderMutationResponse>('/admin/providers', body);
		if (res.ok && res.data?.provider) {
			providers = [...providers, res.data.provider];
			addName = '';
			addUrl = '';
			addApiKey = '';
			showToast('Provider added', 'success');
		} else {
			showToast('Failed to add provider', 'error');
		}
		adding = false;
	}

	// --- Edit provider ---
	function startEdit(provider: ProviderConnection) {
		editingId = provider.id;
		editName = provider.name;
		editUrl = provider.url;
		editApiKey = '';
		confirmDeleteId = null;
	}

	function cancelEdit() {
		editingId = null;
	}

	async function saveEdit() {
		if (!editingId) return;
		if (!editName.trim()) {
			showToast('Provider name is required', 'error');
			return;
		}
		saving = true;
		const body: Record<string, string> = { id: editingId, name: editName.trim() };
		if (editUrl.trim()) body.url = editUrl.trim();
		if (editApiKey.trim()) body.apiKey = editApiKey.trim();

		const res = await apiPost<ProviderMutationResponse>('/admin/providers/update', body);
		if (res.ok && res.data?.provider) {
			providers = providers.map((p) => (p.id === editingId ? res.data.provider : p));
			editingId = null;
			showToast('Provider updated', 'success');
		} else {
			showToast('Failed to update provider', 'error');
		}
		saving = false;
	}

	// --- Delete provider ---
	function startDelete(id: string) {
		confirmDeleteId = id;
		editingId = null;
	}

	function cancelDelete() {
		confirmDeleteId = null;
	}

	async function confirmDelete() {
		if (!confirmDeleteId) return;
		deleting = true;
		const res = await apiPost<{ ok: boolean; deleted: string }>('/admin/providers/delete', {
			id: confirmDeleteId
		});
		if (res.ok) {
			providers = providers.filter((p) => p.id !== confirmDeleteId);
			// Clear models cache for this provider
			const newModels = { ...modelsByProvider };
			delete newModels[confirmDeleteId];
			modelsByProvider = newModels;
			confirmDeleteId = null;
			showToast('Provider deleted', 'success');
		} else {
			showToast('Failed to delete provider', 'error');
		}
		deleting = false;
	}

	// --- Fetch models ---
	async function fetchModels(providerId: string) {
		fetchingModels = { ...fetchingModels, [providerId]: true };
		const res = await apiPost<ModelsResponse>('/admin/providers/models', { providerId });
		if (res.ok && res.data?.models) {
			modelsByProvider = { ...modelsByProvider, [providerId]: res.data.models };
			showToast(`Fetched ${res.data.models.length} model(s)`, 'success');
		} else {
			showToast('Failed to fetch models from provider', 'error');
		}
		fetchingModels = { ...fetchingModels, [providerId]: false };
	}

	// --- Assign model to role ---
	async function assignModel(role: ModelAssignment, providerId: string, modelId: string) {
		if (!providerId || !modelId) {
			showToast('Select both a provider and a model', 'error');
			return;
		}
		if (role === 'small') assigningSmall = true;
		else assigningOpenMem = true;

		const res = await apiPost<AssignResponse>('/admin/providers/assign', {
			role,
			providerId,
			modelId
		});
		if (res.ok && res.data?.assignments) {
			assignments = res.data.assignments;
			showToast(`${role === 'small' ? 'Small' : 'OpenMemory'} model assigned`, 'success');
		} else {
			showToast('Failed to assign model', 'error');
		}
		if (role === 'small') assigningSmall = false;
		else assigningOpenMem = false;
	}

	// --- Helpers ---
	function providerIsConfigured(provider: ProviderConnection): boolean {
		return provider.apiKey === '\u2022\u2022\u2022\u2022\u2022\u2022';
	}

	function getProviderName(id: string): string {
		const p = providers.find((p) => p.id === id);
		return p?.name ?? id;
	}

	function formatDate(dateStr: string): string {
		if (!dateStr) return '';
		try {
			return new Date(dateStr).toLocaleDateString(undefined, {
				year: 'numeric',
				month: 'short',
				day: 'numeric'
			});
		} catch {
			return dateStr;
		}
	}
</script>

<svelte:head>
	<title>Providers - OpenPalm Admin</title>
</svelte:head>

<div class="container">
	<header class="page-header">
		<div>
			<h1>Providers</h1>
			<p class="muted">Manage AI provider endpoints, API keys, and model assignments.</p>
		</div>
	</header>

	{#if loading}
		<LoadingSpinner message="Loading providers..." />
	{:else}
		<!-- Add Provider Form -->
		<section class="section" aria-labelledby="add-heading">
			<h2 id="add-heading">Add Provider</h2>
			<div class="card add-form">
				<form
					onsubmit={(e) => {
						e.preventDefault();
						addProvider();
					}}
				>
					<div class="form-row">
						<div class="form-group form-field-grow">
							<label for="add-name">Name <span class="required" aria-hidden="true">*</span></label>
							<input
								id="add-name"
								type="text"
								bind:value={addName}
								placeholder="e.g. OpenAI, Ollama Local"
								required
								autocomplete="off"
							/>
						</div>
						<div class="form-group form-field-grow">
							<label for="add-url">URL</label>
							<input
								id="add-url"
								type="url"
								bind:value={addUrl}
								placeholder="e.g. https://api.openai.com/v1"
								autocomplete="off"
							/>
						</div>
						<div class="form-group form-field-grow">
							<label for="add-apikey">API Key</label>
							<input
								id="add-apikey"
								type="password"
								bind:value={addApiKey}
								placeholder="Optional"
								autocomplete="new-password"
							/>
						</div>
						<div class="form-group form-field-btn">
							<label class="sr-only" for="add-submit">Add Provider</label>
							<button
								id="add-submit"
								type="submit"
								disabled={adding || !addName.trim()}
							>
								{#if adding}Adding...{:else}Add{/if}
							</button>
						</div>
					</div>
				</form>
			</div>
		</section>

		<!-- Provider List -->
		<section class="section" aria-labelledby="list-heading">
			<h2 id="list-heading">Provider Connections</h2>
			{#if providers.length === 0}
				<div class="empty-state">
					<p>No providers configured yet. Add one above to get started.</p>
				</div>
			{:else}
				<div class="provider-list" role="list" aria-label="Providers">
					{#each providers as provider (provider.id)}
						<div class="card provider-card" role="listitem">
							{#if editingId === provider.id}
								<!-- Edit Mode -->
								<form
									class="edit-form"
									onsubmit={(e) => {
										e.preventDefault();
										saveEdit();
									}}
								>
									<div class="form-group">
										<label for="edit-name-{provider.id}">Name</label>
										<input
											id="edit-name-{provider.id}"
											type="text"
											bind:value={editName}
											required
											autocomplete="off"
										/>
									</div>
									<div class="form-group">
										<label for="edit-url-{provider.id}">URL</label>
										<input
											id="edit-url-{provider.id}"
											type="url"
											bind:value={editUrl}
											placeholder="https://..."
											autocomplete="off"
										/>
									</div>
									<div class="form-group">
										<label for="edit-apikey-{provider.id}">API Key</label>
										<input
											id="edit-apikey-{provider.id}"
											type="password"
											bind:value={editApiKey}
											placeholder="Leave blank to keep current"
											autocomplete="new-password"
										/>
										<p class="help-text">Leave blank to keep the existing key unchanged.</p>
									</div>
									<div class="edit-actions">
										<button type="submit" disabled={saving || !editName.trim()}>
											{#if saving}Saving...{:else}Save{/if}
										</button>
										<button type="button" class="btn-secondary" onclick={cancelEdit}>
											Cancel
										</button>
									</div>
								</form>
							{:else if confirmDeleteId === provider.id}
								<!-- Delete Confirmation -->
								<div class="delete-confirm">
									<p>
										Delete <strong>{provider.name}</strong>? This cannot be undone.
									</p>
									<div class="delete-actions">
										<button
											class="btn-danger"
											onclick={confirmDelete}
											disabled={deleting}
										>
											{#if deleting}Deleting...{:else}Confirm Delete{/if}
										</button>
										<button class="btn-secondary" onclick={cancelDelete}>
											Cancel
										</button>
									</div>
								</div>
							{:else}
								<!-- Display Mode -->
								<div class="provider-header">
									<div class="provider-info">
										<h3>{provider.name}</h3>
										<div class="provider-meta">
											{#if provider.url}
												<span class="provider-url" title={provider.url}>{provider.url}</span>
											{:else}
												<span class="muted">No URL set</span>
											{/if}
											<span class="config-badge" class:configured={providerIsConfigured(provider)}>
												{#if providerIsConfigured(provider)}
													Configured
												{:else}
													No API Key
												{/if}
											</span>
											{#if provider.createdAt}
												<span class="muted date-text">Added {formatDate(provider.createdAt)}</span>
											{/if}
										</div>
									</div>
									<div class="provider-actions">
										<button
											class="btn-secondary btn-sm"
											onclick={() => fetchModels(provider.id)}
											disabled={fetchingModels[provider.id]}
										>
											{#if fetchingModels[provider.id]}Fetching...{:else}Fetch Models{/if}
										</button>
										<button
											class="btn-secondary btn-sm"
											onclick={() => startEdit(provider)}
											aria-label="Edit {provider.name}"
										>
											Edit
										</button>
										<button
											class="btn-danger btn-sm"
											onclick={() => startDelete(provider.id)}
											aria-label="Delete {provider.name}"
										>
											Delete
										</button>
									</div>
								</div>

								<!-- Models list (if fetched) -->
								{#if fetchingModels[provider.id]}
									<div class="models-section">
										<LoadingSpinner size={18} message="Fetching models..." />
									</div>
								{:else if modelsByProvider[provider.id]}
									<div class="models-section">
										<h4>Available Models ({modelsByProvider[provider.id].length})</h4>
										{#if modelsByProvider[provider.id].length === 0}
											<p class="muted">No models returned by this provider.</p>
										{:else}
											<ul class="model-list" role="list" aria-label="Models from {provider.name}">
												{#each modelsByProvider[provider.id] as model (model.id)}
													<li class="model-item">
														<code>{model.id}</code>
														{#if model.object}
															<span class="muted model-type">{model.object}</span>
														{/if}
													</li>
												{/each}
											</ul>
										{/if}
									</div>
								{/if}
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- Model Assignments -->
		<section class="section" aria-labelledby="assign-heading">
			<h2 id="assign-heading">Model Assignments</h2>
			<p class="muted mb">Assign a provider and model to each system role. Fetch models from a provider first to populate the model dropdown.</p>

			<div class="grid2 assign-grid">
				<!-- Small Model Assignment -->
				<div class="card assign-card">
					<h3>Small Model</h3>
					<p class="muted assign-desc">
						Used for lightweight tasks like summarization and classification.
					</p>

					{#if assignments.small?.providerId && assignments.small?.modelId}
						<div class="current-assignment">
							<span class="assign-label">Current:</span>
							<span class="assign-value">
								{getProviderName(assignments.small.providerId)} / {assignments.small.modelId}
							</span>
						</div>
					{:else}
						<p class="muted current-assignment">No model assigned.</p>
					{/if}

					<div class="assign-form">
						<div class="form-group">
							<label for="assign-small-provider">Provider</label>
							<select
								id="assign-small-provider"
								bind:value={assignSmallProvider}
								onchange={() => { assignSmallModel = ''; }}
							>
								<option value="">Select provider...</option>
								{#each providers as p (p.id)}
									<option value={p.id}>{p.name}</option>
								{/each}
							</select>
						</div>
						<div class="form-group">
							<label for="assign-small-model">Model</label>
							{#if assignSmallModels.length > 0}
								<select id="assign-small-model" bind:value={assignSmallModel}>
									<option value="">Select model...</option>
									{#each assignSmallModels as m (m.id)}
										<option value={m.id}>{m.id}</option>
									{/each}
								</select>
							{:else}
								<input
									id="assign-small-model"
									type="text"
									bind:value={assignSmallModel}
									placeholder={assignSmallProvider ? 'Fetch models or type ID' : 'Select a provider first'}
								/>
							{/if}
						</div>
						<button
							onclick={() => assignModel('small', assignSmallProvider, assignSmallModel)}
							disabled={assigningSmall || !assignSmallProvider || !assignSmallModel}
						>
							{#if assigningSmall}Assigning...{:else}Assign{/if}
						</button>
					</div>
				</div>

				<!-- OpenMemory Model Assignment -->
				<div class="card assign-card">
					<h3>OpenMemory Model</h3>
					<p class="muted assign-desc">
						Used for memory operations and knowledge retrieval.
					</p>

					{#if assignments.openmemory?.providerId && assignments.openmemory?.modelId}
						<div class="current-assignment">
							<span class="assign-label">Current:</span>
							<span class="assign-value">
								{getProviderName(assignments.openmemory.providerId)} / {assignments.openmemory.modelId}
							</span>
						</div>
					{:else}
						<p class="muted current-assignment">No model assigned.</p>
					{/if}

					<div class="assign-form">
						<div class="form-group">
							<label for="assign-openmem-provider">Provider</label>
							<select
								id="assign-openmem-provider"
								bind:value={assignOpenMemProvider}
								onchange={() => { assignOpenMemModel = ''; }}
							>
								<option value="">Select provider...</option>
								{#each providers as p (p.id)}
									<option value={p.id}>{p.name}</option>
								{/each}
							</select>
						</div>
						<div class="form-group">
							<label for="assign-openmem-model">Model</label>
							{#if assignOpenMemModels.length > 0}
								<select id="assign-openmem-model" bind:value={assignOpenMemModel}>
									<option value="">Select model...</option>
									{#each assignOpenMemModels as m (m.id)}
										<option value={m.id}>{m.id}</option>
									{/each}
								</select>
							{:else}
								<input
									id="assign-openmem-model"
									type="text"
									bind:value={assignOpenMemModel}
									placeholder={assignOpenMemProvider ? 'Fetch models or type ID' : 'Select a provider first'}
								/>
							{/if}
						</div>
						<button
							onclick={() => assignModel('openmemory', assignOpenMemProvider, assignOpenMemModel)}
							disabled={assigningOpenMem || !assignOpenMemProvider || !assignOpenMemModel}
						>
							{#if assigningOpenMem}Assigning...{:else}Assign{/if}
						</button>
					</div>
				</div>
			</div>
		</section>
	{/if}
</div>

<style>
	.page-header {
		margin-bottom: 1.5rem;
	}
	.page-header h1 {
		margin: 0 0 0.25rem;
		font-size: 1.6rem;
	}
	.page-header p {
		margin: 0;
	}

	.section {
		margin-bottom: 2rem;
	}
	.section h2 {
		font-size: 1.15rem;
		margin: 0 0 0.6rem;
	}

	/* Add form */
	.add-form {
		padding: 1rem 1.2rem;
	}
	.add-form form {
		margin: 0;
	}
	.form-row {
		display: flex;
		gap: 0.75rem;
		align-items: flex-end;
		flex-wrap: wrap;
	}
	.form-field-grow {
		flex: 1 1 180px;
		min-width: 0;
	}
	.form-field-btn {
		flex: 0 0 auto;
		display: flex;
		align-items: flex-end;
	}
	.form-field-btn button {
		height: 2.25rem;
		white-space: nowrap;
	}
	.required {
		color: var(--red);
	}

	/* Provider cards */
	.provider-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}
	.provider-card {
		margin-bottom: 0.75rem;
	}
	.provider-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.provider-info {
		flex: 1 1 auto;
		min-width: 0;
	}
	.provider-info h3 {
		margin: 0 0 0.3rem;
		font-size: 1rem;
	}
	.provider-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		font-size: 13px;
	}
	.provider-url {
		color: var(--muted);
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.date-text {
		font-size: 12px;
	}

	.config-badge {
		display: inline-block;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		background: color-mix(in srgb, var(--muted) 20%, var(--surface));
		color: var(--muted);
	}
	.config-badge.configured {
		background: color-mix(in srgb, var(--green) 15%, var(--surface));
		color: var(--green);
	}

	.provider-actions {
		display: flex;
		gap: 0.4rem;
		flex-shrink: 0;
		align-items: center;
	}

	/* Edit form */
	.edit-form {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.edit-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	/* Delete confirm */
	.delete-confirm {
		text-align: center;
		padding: 0.5rem 0;
	}
	.delete-confirm p {
		margin: 0 0 0.75rem;
	}
	.delete-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: center;
	}

	/* Models section */
	.models-section {
		margin-top: 0.8rem;
		padding-top: 0.8rem;
		border-top: 1px solid var(--border);
	}
	.models-section h4 {
		margin: 0 0 0.4rem;
		font-size: 13px;
		color: var(--muted);
		font-weight: 600;
	}
	.model-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.model-item {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		background: var(--surface2);
		padding: 0.2rem 0.6rem;
		border-radius: calc(var(--radius) / 2);
		font-size: 12px;
	}
	.model-item code {
		font-size: 12px;
		color: var(--accent2);
	}
	.model-type {
		font-size: 11px;
	}

	/* Assignment cards */
	.assign-grid {
		margin-top: 0.5rem;
	}
	.assign-card h3 {
		margin: 0 0 0.25rem;
		font-size: 1rem;
	}
	.assign-desc {
		margin: 0 0 0.6rem;
		font-size: 13px;
	}
	.current-assignment {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 0.75rem;
		padding: 0.4rem 0.65rem;
		background: var(--surface2);
		border-radius: calc(var(--radius) / 2);
		font-size: 13px;
	}
	.assign-label {
		font-weight: 600;
		color: var(--muted);
		flex-shrink: 0;
	}
	.assign-value {
		color: var(--accent2);
		word-break: break-all;
	}
	p.current-assignment {
		color: var(--muted);
		font-style: italic;
	}
	.assign-form {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.assign-form button {
		margin-top: 0.5rem;
		align-self: flex-start;
	}

	/* Responsive */
	@media (max-width: 700px) {
		.form-row {
			flex-direction: column;
		}
		.form-field-grow {
			flex: 1 1 auto;
		}
		.provider-header {
			flex-direction: column;
		}
		.provider-actions {
			width: 100%;
		}
		.provider-actions button {
			flex: 1;
		}
	}
</style>
