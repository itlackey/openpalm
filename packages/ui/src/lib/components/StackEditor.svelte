<script lang="ts">
	import { api } from '$lib/api';
	import { showToast } from '$lib/stores/toast.svelte';
	import { getAdminToken } from '$lib/stores/auth.svelte';

	type CatalogField = {
		key: string;
		required: boolean;
		description?: string;
		defaultValue?: string;
	};

	type CatalogItem = {
		id: string;
		type: 'channel' | 'service';
		name: string;
		displayName: string;
		description: string;
		tags: string[];
		enabled: boolean;
		installed: boolean;
		entryKind: 'installed' | 'template';
		templateName?: string;
		supportsMultipleInstances?: boolean;
		exposure?: 'host' | 'lan' | 'public';
		config: Record<string, string>;
		fields: CatalogField[];
		image?: string;
		containerPort?: number;
		rewritePath?: string;
		sharedSecretEnv?: string;
		volumes?: string[];
		dependsOn?: string[];
	};

	let specText = $state('');
	let statusMsg = $state('');
	let activeView = $state<'configure' | 'add' | 'advanced'>('configure');
	let catalog = $state<CatalogItem[]>([]);
	let addSearch = $state('');
	let addTypeFilter = $state<'all' | 'channel' | 'service'>('all');
	let configureTypeFilter = $state<'all' | 'channel' | 'service'>('all');
	let secretNames = $state<string[]>([]);
	let editingItemKey = $state('');
	let configDraft = $state<Record<string, string>>({});
	let exposureDraft = $state<'host' | 'lan' | 'public'>('lan');
	let busyItemKey = $state('');

	const hasToken = $derived(getAdminToken().length > 0);
	const enabledInstalledItems = $derived.by(() =>
		catalog.filter(
			(item) =>
				item.entryKind === 'installed' &&
				item.enabled &&
				(configureTypeFilter === 'all' || item.type === configureTypeFilter)
		)
	);
	const activeSingleInstanceTemplateKeys = $derived.by(() => {
		const keys = new Set<string>();
		for (const item of enabledInstalledItems) {
			const templateName = item.templateName ?? item.name;
			if (!templateName) continue;
			if (item.supportsMultipleInstances === true) continue;
			keys.add(`${item.type}:${templateName}`);
		}
		return keys;
	});
	const searchInstallItems = $derived.by(() => {
		const q = addSearch.trim().toLowerCase();
		return catalog.filter((item) => {
			if (item.entryKind !== 'template') return false;
			if (addTypeFilter !== 'all' && item.type !== addTypeFilter) return false;
			if (q) {
				const haystack = [
					item.name,
					item.displayName,
					item.description,
					...(item.tags ?? [])
				]
					.join(' ')
					.toLowerCase();
				if (!haystack.includes(q)) return false;
			}
			const templateName = item.templateName ?? item.name;
			if (!templateName) return false;
			if (item.supportsMultipleInstances === true) return true;
			return !activeSingleInstanceTemplateKeys.has(`${item.type}:${templateName}`);
		});
	});

	function itemKey(item: CatalogItem): string {
		return item.id;
	}

	function isSecretField(field: CatalogField): boolean {
		const upper = field.key.toUpperCase();
		return (
			upper.includes('SECRET') ||
			upper.includes('TOKEN') ||
			upper.endsWith('_KEY') ||
			upper.includes('PASSWORD')
		);
	}

	function beginConfigure(item: CatalogItem) {
		editingItemKey = itemKey(item);
		configDraft = { ...item.config };
		exposureDraft = item.exposure ?? 'lan';
	}

	function applySecretRef(fieldKey: string, secretName: string) {
		if (!secretName) return;
		configDraft = { ...configDraft, [fieldKey]: buildSecretReference(secretName) };
	}

	function buildSecretReference(secretName: string): string {
		return `\${${secretName}}`;
	}

	async function loadState() {
		if (!hasToken) {
			specText = '(Enter admin password above to load)';
			return;
		}
		const r = await api('/state');
		if (!r.ok) return;
		const data = r.data?.data ?? {};
		catalog = data.catalog ?? [];
		secretNames = data.secrets?.available ?? [];
	}

	async function refreshSharedState() {
		await Promise.all([loadState(), loadSpec()]);
	}

	function notifyRefreshError(error: unknown, fallbackMessage: string) {
		const message = error instanceof Error ? error.message : fallbackMessage;
		showToast(message, 'error');
	}

	async function loadSpec() {
		if (!hasToken) {
			specText = '(Enter admin password above to load)';
			return;
		}
		const r = await api('/stack/spec');
		if (r.ok && r.data?.yaml) {
			specText = r.data.yaml;
		} else {
			specText = '# Could not load stack spec: ' + (r.data?.error || 'unknown error');
		}
	}

	async function saveSpec() {
		if (!hasToken) {
			showToast('Enter admin password first.', 'error');
			return;
		}
		const r = await api('/stack/spec', {
			method: 'POST',
			body: JSON.stringify({ yaml: specText })
		});
		if (r.ok) {
			specText = r.data.yaml;
			showToast('Stack spec saved.', 'success');
			statusMsg = 'Saved. Click "Apply Changes" to regenerate configs and restart services.';
			await loadState();
		} else {
			showToast('Save failed: ' + (r.data?.error || r.data?.details || 'unknown'), 'error');
			statusMsg = '';
		}
	}

	async function applyStack() {
		if (!hasToken) {
			showToast('Enter admin password first.', 'error');
			return;
		}
		statusMsg = 'Applying...';
		const r = await api('/stack/apply', { method: 'POST' });
		if (r.ok) {
			showToast('Stack applied successfully.', 'success');
			const caddyReloaded = r.data?.caddyReloaded ?? false;
			statusMsg = caddyReloaded ? 'Applied. Caddy config reloaded.' : 'Applied successfully.';
		} else {
			showToast(
				'Apply failed: ' + (r.data?.error || r.data?.details || 'unknown'),
				'error'
			);
			statusMsg = '';
		}
	}

	async function mutateItem(item: CatalogItem, action: 'install' | 'uninstall' | 'add_instance') {
		busyItemKey = itemKey(item);
		const r = await api('/command', {
			method: 'POST',
			body: JSON.stringify({
				type: 'stack.catalog.item',
				payload: {
					action,
					itemType: item.type,
					name: item.name,
					templateName: item.templateName ?? item.name,
					supportsMultipleInstances: item.supportsMultipleInstances === true,
					displayName: item.displayName,
					description: item.description,
					fields: item.fields,
					image: item.image,
					containerPort: item.containerPort,
					rewritePath: item.rewritePath,
					sharedSecretEnv: item.sharedSecretEnv,
					volumes: item.volumes,
					dependsOn: item.dependsOn
				}
			})
		});
		busyItemKey = '';
		if (!r.ok) {
			showToast(r.data?.error || `Failed to ${action} ${item.displayName}`, 'error');
			return;
		}
		const addedInstanceId = typeof r.data?.data?.item?.id === 'string' ? r.data.data.item.id : null;
		await refreshSharedState();
		if (action === 'add_instance' && addedInstanceId) {
			const installedInstance = catalog.find(
				(entry) => entry.id === addedInstanceId && entry.entryKind === 'installed'
			);
			if (installedInstance) {
				activeView = 'configure';
				beginConfigure(installedInstance);
			}
		}
		const actionLabelMap = {
			install: 'installed',
			uninstall: 'uninstalled',
			add_instance: 'instance added'
		} as const;
		const actionLabel = actionLabelMap[action];
		showToast(`${item.displayName} ${actionLabel}`, 'success');
	}

	async function saveItemConfig(item: CatalogItem) {
		busyItemKey = itemKey(item);
		const r = await api('/command', {
			method: 'POST',
			body: JSON.stringify({
				type: 'stack.catalog.item',
				payload: {
					action: 'configure',
					itemType: item.type,
					name: item.name,
					exposure: item.type === 'channel' ? exposureDraft : undefined,
					config: configDraft
				}
			})
		});
		busyItemKey = '';
		if (!r.ok) {
			showToast(r.data?.error || `Failed to configure ${item.displayName}`, 'error');
			return;
		}
		editingItemKey = '';
		await refreshSharedState();
		showToast(`${item.displayName} configured`, 'success');
	}

	async function selectView(view: 'configure' | 'add' | 'advanced') {
		activeView = view;
		if (!hasToken) return;
		try {
			if (view === 'configure' || view === 'add') {
				await loadState();
				return;
			}
			await loadSpec();
		} catch (error) {
			notifyRefreshError(error, 'Failed to refresh view state');
		}
	}

	$effect(() => {
		if (hasToken) {
			void refreshSharedState().catch((error) =>
				notifyRefreshError(error, 'Failed to load stack state')
			);
		}
	});
</script>

<div class="card">
	<h3>Stack Configuration</h3>
	<div style="display:flex;gap:0.4rem;margin-bottom:0.6rem;align-items:center">
		<div style="display:flex;gap:0.4rem">
			<button
				class={activeView === 'configure' ? '' : 'btn-secondary'}
				onclick={() => selectView('configure')}>Configure</button
			>
			<button class={activeView === 'add' ? '' : 'btn-secondary'} onclick={() => selectView('add')}
				>Add</button
			>
			<button
				class={activeView === 'advanced' ? '' : 'btn-secondary'}
				onclick={() => selectView('advanced')}>Advanced YAML</button
			>
		</div>
		<div style="margin-left:auto">
			<button
				class="btn-secondary"
				onclick={async () => {
					try {
						await refreshSharedState();
					} catch (error) {
						notifyRefreshError(error, 'Failed to reload stack state');
					}
				}}>Reload</button
			>
		</div>
	</div>
	{#if activeView === 'configure'}
		<p class="muted" style="font-size:13px">
			Configure enabled channels and services currently running in your stack.
		</p>
		<div style="display:flex;gap:0.5rem;max-width:18rem;margin:0.5rem 0">
			<select bind:value={configureTypeFilter}>
				<option value="all">All types</option>
				<option value="channel">Channels</option>
				<option value="service">Services</option>
			</select>
		</div>
		{#if enabledInstalledItems.length === 0}
			<div class="muted" style="font-size:13px">
				No enabled containers match your filter. Use the Add tab to add new containers.
			</div>
		{:else}
			<div style="display:grid;gap:0.6rem">
				{#each enabledInstalledItems as item}
					{@const key = itemKey(item)}
					<div class="channel-section {item.enabled ? 'enabled' : ''}">
						<div style="display:flex;justify-content:space-between;gap:0.6rem;align-items:flex-start">
							<div>
								<div><strong>{item.displayName}</strong> <span class="muted">({item.type})</span></div>
								{#if item.description}
									<div class="muted" style="font-size:13px">{item.description}</div>
								{/if}
								<div class="muted" style="font-size:12px">Tags: {item.tags.join(', ')}</div>
							</div>
							<div style="display:flex;gap:0.35rem;flex-wrap:wrap">
								<button class="btn-secondary btn-sm" onclick={() => beginConfigure(item)}
									>Configure</button
								>
								<button
									class="btn-secondary btn-sm"
									disabled={busyItemKey === key}
									onclick={() => mutateItem(item, 'uninstall')}>Uninstall</button
								>
								{#if item.supportsMultipleInstances}
									<button
										class="btn-secondary btn-sm"
										disabled={busyItemKey === key}
										onclick={() => mutateItem(item, 'add_instance')}>Add instance</button
									>
								{/if}
							</div>
						</div>
						{#if editingItemKey === key}
							<div style="margin-top:0.5rem">
								{#if item.type === 'channel'}
									<label for="exposure-select" style="display:block;font-size:13px;margin-bottom:0.2rem">Exposure</label>
									<select id="exposure-select" bind:value={exposureDraft} style="margin-bottom:0.45rem">
										<option value="host">host</option>
										<option value="lan">lan</option>
										<option value="public">public</option>
									</select>
								{/if}
								{#if item.fields.length === 0}
									<div class="muted" style="font-size:13px">No configuration fields defined.</div>
								{/if}
								{#each item.fields as field}
									<label for="cfg-{item.name}-{field.key}" style="display:block;margin:0.35rem 0 0.2rem;font-size:13px">
										{field.key}{field.required ? ' *' : ''}
									</label>
									<input
										id="cfg-{item.name}-{field.key}"
										type={isSecretField(field) ? 'password' : 'text'}
										value={configDraft[field.key] ?? ''}
										oninput={(event) =>
											(configDraft = {
												...configDraft,
												[field.key]: (event.currentTarget as HTMLInputElement).value
											})}
										placeholder={field.description ?? ''}
									/>
									{#if secretNames.length > 0}
										<select
											style="margin-top:0.2rem"
											onchange={(event) =>
												applySecretRef(
													field.key,
													(event.currentTarget as HTMLSelectElement).value
												)}>
											<option value="">Use plain value</option>
											{#each secretNames as secretName}
												<option value={secretName}>Use secret: {secretName}</option>
											{/each}
										</select>
									{/if}
								{/each}
								<div style="display:flex;gap:0.4rem;margin-top:0.55rem">
									<button disabled={busyItemKey === key} onclick={() => saveItemConfig(item)}
										>Save configuration</button
									>
									<button class="btn-secondary" onclick={() => (editingItemKey = '')}>Cancel</button>
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{:else if activeView === 'add'}
		<p class="muted" style="font-size:13px">
			Search available templates and add new channels/services to your stack.
		</p>
		<div class="grid2" style="margin:0.5rem 0">
			<input bind:value={addSearch} placeholder="Search by name, description, or tag" />
			<select bind:value={addTypeFilter}>
				<option value="all">All types</option>
				<option value="channel">Channels</option>
				<option value="service">Services</option>
			</select>
		</div>
		{#if searchInstallItems.length === 0}
			<div class="muted" style="font-size:13px">
				No installable containers matched your search.
			</div>
		{:else}
			<div style="display:grid;gap:0.6rem">
				{#each searchInstallItems as item}
					{@const key = itemKey(item)}
					<div class="channel-section">
						<div style="display:flex;justify-content:space-between;gap:0.6rem;align-items:flex-start">
							<div>
								<div><strong>{item.displayName}</strong> <span class="muted">({item.type})</span></div>
								{#if item.description}
									<div class="muted" style="font-size:13px">{item.description}</div>
								{/if}
								<div class="muted" style="font-size:12px">Tags: {item.tags.join(', ')}</div>
							</div>
							<div style="display:flex;gap:0.35rem;flex-wrap:wrap">
								<button disabled={busyItemKey === key} onclick={() => mutateItem(item, 'add_instance')}
									>{item.supportsMultipleInstances ? 'Add instance' : 'Add'}</button
								>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	{:else}
		<p class="muted" style="font-size:13px">
			Advanced mode: edit stack YAML directly. Save, then Apply to regenerate configuration files and
			restart services.
		</p>
		<textarea
			bind:value={specText}
			rows="16"
			style="width:100%;margin:0.5rem 0"
			placeholder="Loading..."
		></textarea>
		<div style="display:flex;gap:0.5rem">
			<button onclick={saveSpec}>Save Spec</button>
			<button class="btn-secondary" onclick={applyStack}>Apply Changes</button>
		</div>
	{/if}
	{#if statusMsg}
		<div style="margin-top:0.5rem;font-size:13px" class="muted">{statusMsg}</div>
	{/if}
</div>
