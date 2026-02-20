<script lang="ts">
	import { apiGet, apiPost } from '$lib/api';
	import { showToast } from '$lib/stores/toast';
	import Modal from '$lib/components/Modal.svelte';
	import RiskBadge from '$lib/components/RiskBadge.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import type { GalleryItem, GalleryCategory } from '$lib/types';

	type View = 'gallery' | 'installed';
	type GalleryTab = 'curated' | 'npm' | 'community';

	type CategoryCount = { category: string; count: number };
	type NpmResult = { name: string; description: string; version: string; author: string };
	type RiskBadgeInfo = { label: string; color: string; description: string };

	const ALL_CATEGORIES: GalleryCategory[] = [
		'plugin', 'skill', 'command', 'agent', 'tool', 'channel', 'service'
	];

	// ── State ──

	let view = $state<View>('gallery');
	let galleryTab = $state<GalleryTab>('curated');

	// Gallery search / filter
	let searchQuery = $state('');
	let selectedCategory = $state<GalleryCategory | ''>('');
	let galleryItems = $state<GalleryItem[]>([]);
	let galleryTotal = $state(0);
	let galleryLoading = $state(false);

	// Categories sidebar
	let categories = $state<CategoryCount[]>([]);

	// Detail modal
	let detailItem = $state<GalleryItem | null>(null);
	let detailRiskBadge = $state<RiskBadgeInfo | null>(null);
	let detailLoading = $state(false);
	let detailModalOpen = $state(false);

	// npm search
	let npmQuery = $state('');
	let npmResults = $state<NpmResult[]>([]);
	let npmLoading = $state(false);

	// Community
	let communityQuery = $state('');
	let communityCategory = $state<GalleryCategory | ''>('');
	let communityItems = $state<GalleryItem[]>([]);
	let communityTotal = $state(0);
	let communityLoading = $state(false);
	let communityRefreshing = $state(false);

	// Installed
	let installedPlugins = $state<string[]>([]);
	let installedLoading = $state(false);

	// In-flight install/uninstall tracking
	let installingIds = $state<Set<string>>(new Set());
	let uninstallingIds = $state<Set<string>>(new Set());

	// Search debounce timer
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let communitySearchTimer: ReturnType<typeof setTimeout> | undefined;

	// ── Derived ──

	let installedSet = $derived(new Set(installedPlugins));

	// Non-null accessor for use inside snippets where narrowing doesn't apply
	function detail(): GalleryItem {
		return detailItem!;
	}

	// ── Effects ──

	$effect(() => {
		loadCategories();
		loadInstalled();
	});

	$effect(() => {
		// Re-search when category changes (immediate)
		// We reference selectedCategory to create dependency
		const _cat = selectedCategory;
		const _q = searchQuery;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			searchGallery(_q, _cat);
		}, 300);
	});

	// ── API Functions ──

	async function loadCategories() {
		const res = await apiGet<{ categories: CategoryCount[] }>('/admin/gallery/categories');
		if (res.ok && res.data?.categories) {
			categories = res.data.categories;
		}
	}

	async function searchGallery(q: string, cat: GalleryCategory | '') {
		galleryLoading = true;
		const params = new URLSearchParams();
		if (q) params.set('q', q);
		if (cat) params.set('category', cat);
		const res = await apiGet<{ items: GalleryItem[]; total: number }>(
			`/admin/gallery/search?${params.toString()}`
		);
		if (res.ok && res.data) {
			galleryItems = res.data.items ?? [];
			galleryTotal = res.data.total ?? 0;
		} else {
			galleryItems = [];
			galleryTotal = 0;
		}
		galleryLoading = false;
	}

	async function openDetail(item: GalleryItem) {
		detailItem = item;
		detailRiskBadge = null;
		detailModalOpen = true;
		detailLoading = true;
		const res = await apiGet<{ item: GalleryItem; riskBadge: RiskBadgeInfo }>(
			`/admin/gallery/item/${encodeURIComponent(item.id)}`
		);
		if (res.ok && res.data) {
			detailItem = res.data.item ?? item;
			detailRiskBadge = res.data.riskBadge ?? null;
		}
		detailLoading = false;
	}

	function closeDetail() {
		detailModalOpen = false;
		detailItem = null;
		detailRiskBadge = null;
	}

	async function searchNpm() {
		if (!npmQuery.trim()) return;
		npmLoading = true;
		const res = await apiGet<{ results: NpmResult[] }>(
			`/admin/gallery/npm-search?q=${encodeURIComponent(npmQuery)}`
		);
		if (res.ok && res.data?.results) {
			npmResults = res.data.results;
		} else {
			npmResults = [];
		}
		npmLoading = false;
	}

	async function searchCommunity() {
		communityLoading = true;
		const params = new URLSearchParams();
		if (communityQuery) params.set('q', communityQuery);
		if (communityCategory) params.set('category', communityCategory);
		const res = await apiGet<{ items: GalleryItem[]; total: number; source: string }>(
			`/admin/gallery/community?${params.toString()}`
		);
		if (res.ok && res.data) {
			communityItems = res.data.items ?? [];
			communityTotal = res.data.total ?? 0;
		} else {
			communityItems = [];
			communityTotal = 0;
		}
		communityLoading = false;
	}

	async function refreshCommunity() {
		communityRefreshing = true;
		const res = await apiPost<{ ok: boolean; total: number; refreshedAt: string }>(
			'/admin/gallery/community/refresh'
		);
		if (res.ok && res.data?.ok) {
			showToast(`Community registry refreshed (${res.data.total} items)`, 'success');
			await searchCommunity();
		} else {
			showToast('Failed to refresh community registry', 'error');
		}
		communityRefreshing = false;
	}

	async function loadInstalled() {
		installedLoading = true;
		const res = await apiGet<{ plugins: string[]; setupState: unknown }>('/admin/installed');
		if (res.ok && res.data?.plugins) {
			installedPlugins = res.data.plugins;
		} else {
			installedPlugins = [];
		}
		installedLoading = false;
	}

	async function installExtension(item: GalleryItem) {
		const trackingId = item.id;
		installingIds = new Set([...installingIds, trackingId]);
		const body: Record<string, string> = { galleryId: item.id };
		const res = await apiPost<{ ok: boolean }>('/admin/gallery/install', body);
		if (res.ok) {
			showToast(`Installed ${item.name}`, 'success');
			await loadInstalled();
		} else {
			showToast(`Failed to install ${item.name}`, 'error');
		}
		installingIds = new Set([...installingIds].filter((id) => id !== trackingId));
	}

	async function uninstallExtension(item: GalleryItem) {
		const trackingId = item.id;
		uninstallingIds = new Set([...uninstallingIds, trackingId]);
		const body: Record<string, string> = { galleryId: item.id };
		const res = await apiPost<{ ok: boolean }>('/admin/gallery/uninstall', body);
		if (res.ok) {
			showToast(`Uninstalled ${item.name}`, 'success');
			await loadInstalled();
		} else {
			showToast(`Failed to uninstall ${item.name}`, 'error');
		}
		uninstallingIds = new Set([...uninstallingIds].filter((id) => id !== trackingId));
	}

	async function installNpmPlugin(name: string) {
		installingIds = new Set([...installingIds, name]);
		const res = await apiPost<{ ok: boolean }>('/admin/gallery/install', { pluginId: name });
		if (res.ok) {
			showToast(`Installed ${name}`, 'success');
			await loadInstalled();
		} else {
			showToast(`Failed to install ${name}`, 'error');
		}
		installingIds = new Set([...installingIds].filter((id) => id !== name));
	}

	async function uninstallPlugin(pluginId: string) {
		uninstallingIds = new Set([...uninstallingIds, pluginId]);
		const res = await apiPost<{ ok: boolean }>('/admin/gallery/uninstall', { pluginId });
		if (res.ok) {
			showToast(`Uninstalled ${pluginId}`, 'success');
			await loadInstalled();
		} else {
			showToast(`Failed to uninstall ${pluginId}`, 'error');
		}
		uninstallingIds = new Set([...uninstallingIds].filter((id) => id !== pluginId));
	}

	function isInstalled(item: GalleryItem): boolean {
		return installedSet.has(item.installTarget) || installedSet.has(item.id);
	}

	function handleCommunityInput() {
		clearTimeout(communitySearchTimer);
		communitySearchTimer = setTimeout(() => {
			searchCommunity();
		}, 300);
	}

	function handleGalleryTabChange(tab: GalleryTab) {
		galleryTab = tab;
		if (tab === 'community' && communityItems.length === 0) {
			searchCommunity();
		}
	}
</script>

<div class="container">
	<div class="page-header">
		<h1>Extensions</h1>
		<div class="view-toggle" role="tablist" aria-label="Extension views">
			<button
				role="tab"
				aria-selected={view === 'gallery'}
				class:active={view === 'gallery'}
				onclick={() => (view = 'gallery')}
			>
				Gallery
			</button>
			<button
				role="tab"
				aria-selected={view === 'installed'}
				class:active={view === 'installed'}
				onclick={() => { view = 'installed'; loadInstalled(); }}
			>
				My Extensions
			</button>
		</div>
	</div>

	{#if view === 'gallery'}
		<!-- Gallery sub-tabs -->
		<div class="sub-tabs" role="tablist" aria-label="Gallery sections">
			<button
				role="tab"
				aria-selected={galleryTab === 'curated'}
				class:active={galleryTab === 'curated'}
				onclick={() => handleGalleryTabChange('curated')}
			>
				Browse
			</button>
			<button
				role="tab"
				aria-selected={galleryTab === 'npm'}
				class:active={galleryTab === 'npm'}
				onclick={() => handleGalleryTabChange('npm')}
			>
				npm Search
			</button>
			<button
				role="tab"
				aria-selected={galleryTab === 'community'}
				class:active={galleryTab === 'community'}
				onclick={() => handleGalleryTabChange('community')}
			>
				Community
			</button>
		</div>

		{#if galleryTab === 'curated'}
			<!-- Search -->
			<div class="search-row">
				<input
					type="search"
					placeholder="Search extensions..."
					bind:value={searchQuery}
					aria-label="Search extensions"
				/>
			</div>

			<!-- Category tabs -->
			<div class="category-tabs" role="tablist" aria-label="Filter by category">
				<button
					role="tab"
					aria-selected={selectedCategory === ''}
					class:active={selectedCategory === ''}
					class="cat-tab"
					onclick={() => (selectedCategory = '')}
				>
					All
				</button>
				{#each ALL_CATEGORIES as cat}
					{@const count = categories.find((c) => c.category === cat)?.count ?? 0}
					<button
						role="tab"
						aria-selected={selectedCategory === cat}
						class:active={selectedCategory === cat}
						class="cat-tab"
						onclick={() => (selectedCategory = cat)}
					>
						{cat.charAt(0).toUpperCase() + cat.slice(1)}
						{#if count > 0}
							<span class="cat-count">{count}</span>
						{/if}
					</button>
				{/each}
			</div>

			<!-- Results -->
			{#if galleryLoading}
				<LoadingSpinner message="Searching extensions..." />
			{:else if galleryItems.length === 0}
				<div class="empty-state">
					<p>No extensions found{searchQuery ? ` for "${searchQuery}"` : ''}.</p>
				</div>
			{:else}
				<p class="muted results-count">{galleryTotal} extension{galleryTotal !== 1 ? 's' : ''} found</p>
				<div class="grid2">
					{#each galleryItems as item (item.id)}
						{@const installed = isInstalled(item)}
						<button
							class="ext-card"
							onclick={() => openDetail(item)}
							aria-label="View details for {item.name}"
						>
							<div class="ext-card-header">
								<h3 class="ext-name">{item.name}</h3>
								<RiskBadge risk={item.risk} />
							</div>
							<p class="ext-desc">{item.description}</p>
							<div class="ext-card-footer">
								<span class="ext-category">{item.category}</span>
								{#if item.author}
									<span class="ext-author muted">by {item.author}</span>
								{/if}
								{#if installed}
									<span class="installed-badge">Installed</span>
								{/if}
							</div>
						</button>
					{/each}
				</div>
			{/if}
		{:else if galleryTab === 'npm'}
			<!-- npm search -->
			<div class="search-row">
				<input
					type="search"
					placeholder="Search npm for plugins..."
					bind:value={npmQuery}
					aria-label="Search npm registry"
					onkeydown={(e) => { if (e.key === 'Enter') searchNpm(); }}
				/>
				<button onclick={searchNpm} disabled={npmLoading || !npmQuery.trim()} aria-label="Search npm">
					{npmLoading ? 'Searching...' : 'Search'}
				</button>
			</div>

			<p class="muted mb npm-notice">
				Search the npm registry for OpenPalm-compatible plugins. These packages are unreviewed and may carry higher risk.
			</p>

			{#if npmLoading}
				<LoadingSpinner message="Searching npm..." />
			{:else if npmResults.length > 0}
				<div class="npm-results">
					{#each npmResults as pkg (pkg.name)}
						{@const alreadyInstalled = installedSet.has(pkg.name)}
						<div class="card npm-card">
							<div class="flex-between">
								<div>
									<h3>{pkg.name}</h3>
									<p class="muted">{pkg.description || 'No description'}</p>
									<div class="npm-meta">
										<span class="muted">v{pkg.version}</span>
										{#if pkg.author}
											<span class="muted">by {pkg.author}</span>
										{/if}
									</div>
								</div>
								<div class="npm-actions">
									{#if alreadyInstalled}
										<span class="installed-badge">Installed</span>
									{:else}
										<button
											class="btn-sm"
											disabled={installingIds.has(pkg.name)}
											onclick={() => installNpmPlugin(pkg.name)}
											aria-label="Install {pkg.name}"
										>
											{installingIds.has(pkg.name) ? 'Installing...' : 'Install'}
										</button>
									{/if}
								</div>
							</div>
						</div>
					{/each}
				</div>
			{:else if npmQuery.trim()}
				<div class="empty-state">
					<p>No npm packages found for "{npmQuery}".</p>
				</div>
			{/if}
		{:else if galleryTab === 'community'}
			<!-- Community registry -->
			<div class="search-row">
				<input
					type="search"
					placeholder="Search community extensions..."
					bind:value={communityQuery}
					oninput={handleCommunityInput}
					aria-label="Search community extensions"
				/>
				<select
					bind:value={communityCategory}
					onchange={() => searchCommunity()}
					aria-label="Filter community by category"
				>
					<option value="">All Categories</option>
					{#each ALL_CATEGORIES as cat}
						<option value={cat}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
					{/each}
				</select>
				<button
					class="btn-secondary"
					onclick={refreshCommunity}
					disabled={communityRefreshing}
					aria-label="Refresh community registry"
				>
					{communityRefreshing ? 'Refreshing...' : 'Refresh'}
				</button>
			</div>

			{#if communityLoading}
				<LoadingSpinner message="Loading community extensions..." />
			{:else if communityItems.length === 0}
				<div class="empty-state">
					<p>No community extensions found.</p>
				</div>
			{:else}
				<p class="muted results-count">{communityTotal} community extension{communityTotal !== 1 ? 's' : ''}</p>
				<div class="grid2">
					{#each communityItems as item (item.id)}
						{@const installed = isInstalled(item)}
						<button
							class="ext-card"
							onclick={() => openDetail(item)}
							aria-label="View details for {item.name}"
						>
							<div class="ext-card-header">
								<h3 class="ext-name">{item.name}</h3>
								<RiskBadge risk={item.risk} />
							</div>
							<p class="ext-desc">{item.description}</p>
							<div class="ext-card-footer">
								<span class="ext-category">{item.category}</span>
								{#if item.author}
									<span class="ext-author muted">by {item.author}</span>
								{/if}
								{#if installed}
									<span class="installed-badge">Installed</span>
								{/if}
							</div>
						</button>
					{/each}
				</div>
			{/if}
		{/if}
	{:else}
		<!-- My Extensions (installed) -->
		{#if installedLoading}
			<LoadingSpinner message="Loading installed extensions..." />
		{:else if installedPlugins.length === 0}
			<div class="empty-state">
				<p>No extensions installed yet.</p>
				<button onclick={() => (view = 'gallery')} aria-label="Browse the extension gallery">
					Browse Gallery
				</button>
			</div>
		{:else}
			<p class="muted mb">{installedPlugins.length} extension{installedPlugins.length !== 1 ? 's' : ''} installed</p>
			<div class="installed-list">
				{#each installedPlugins as pluginId (pluginId)}
					<div class="card installed-card">
						<div class="flex-between">
							<div>
								<h3>{pluginId}</h3>
							</div>
							<button
								class="btn-danger btn-sm"
								disabled={uninstallingIds.has(pluginId)}
								onclick={() => uninstallPlugin(pluginId)}
								aria-label="Uninstall {pluginId}"
							>
								{uninstallingIds.has(pluginId) ? 'Removing...' : 'Uninstall'}
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<!-- Detail Modal -->
{#if detailItem}
	<Modal title={detailItem.name} open={detailModalOpen} onclose={closeDetail}>
		{#snippet children()}
			{#if detailLoading}
				<LoadingSpinner message="Loading details..." />
			{:else}
				<div class="detail-content">
					<!-- Risk + category row -->
					<div class="detail-meta-row">
						<RiskBadge risk={detail().risk} />
						<span class="ext-category">{detail().category}</span>
						{#if detail().version}
							<span class="muted">v{detail().version}</span>
						{/if}
						{#if detail().author}
							<span class="muted">by {detail().author}</span>
						{/if}
						{#if detail().builtIn}
							<span class="builtin-badge">Built-in</span>
						{/if}
					</div>

					<!-- Risk badge description -->
					{#if detailRiskBadge}
						<div class="detail-risk-info">
							<strong>Risk: {detailRiskBadge.label}</strong>
							<p class="muted">{detailRiskBadge.description}</p>
						</div>
					{/if}

					<!-- Description -->
					<div class="detail-section">
						<h4>Description</h4>
						<p>{detail().description}</p>
					</div>

					<!-- Tags -->
					{#if detail().tags && detail().tags!.length > 0}
						<div class="detail-section">
							<h4>Tags</h4>
							<div class="tag-list">
								{#each detail().tags! as tag}
									<span class="tag">{tag}</span>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Permissions -->
					{#if detail().permissions && detail().permissions!.length > 0}
						<div class="detail-section">
							<h4>Permissions</h4>
							<ul class="permission-list">
								{#each detail().permissions! as perm}
									<li>{perm}</li>
								{/each}
							</ul>
						</div>
					{/if}

					<!-- Security notes -->
					{#if detail().securityNotes}
						<div class="detail-section security-notes">
							<h4>Security Notes</h4>
							<p>{detail().securityNotes}</p>
						</div>
					{/if}

					<!-- Doc link -->
					{#if detail().docUrl}
						<div class="detail-section">
							<a href={detail().docUrl} target="_blank" rel="noopener noreferrer">
								View Documentation
							</a>
						</div>
					{/if}

					<!-- Source -->
					<div class="detail-section">
						<span class="muted">Source: {detail().source}</span>
					</div>
				</div>
			{/if}
		{/snippet}
		{#snippet footer()}
			{@const item = detail()}
			{@const installed = isInstalled(item)}
			{#if installed}
				<button
					class="btn-danger"
					disabled={uninstallingIds.has(item.id)}
					onclick={() => uninstallExtension(item)}
					aria-label="Uninstall {item.name}"
				>
					{uninstallingIds.has(item.id) ? 'Uninstalling...' : 'Uninstall'}
				</button>
			{:else}
				<button
					disabled={installingIds.has(item.id) || item.builtIn}
					onclick={() => installExtension(item)}
					aria-label="Install {item.name}"
				>
					{#if item.builtIn}
						Built-in
					{:else if installingIds.has(item.id)}
						Installing...
					{:else}
						Install
					{/if}
				</button>
			{/if}
			<button class="btn-secondary" onclick={closeDetail}>Close</button>
		{/snippet}
	</Modal>
{/if}

<style>
	/* Page header */
	.page-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	.page-header h1 {
		margin: 0;
		font-size: 1.5rem;
	}

	/* View toggle */
	.view-toggle {
		display: flex;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}

	.view-toggle button {
		background: transparent;
		color: var(--muted);
		border: none;
		border-radius: 0;
		padding: 0.45rem 1rem;
		font-size: 14px;
		font-weight: 500;
		transition: background 0.15s, color 0.15s;
	}

	.view-toggle button:hover {
		color: var(--text);
		background: var(--surface2);
	}

	.view-toggle button.active {
		background: var(--accent);
		color: #fff;
	}

	/* Sub-tabs (Gallery sections) */
	.sub-tabs {
		display: flex;
		gap: 0.25rem;
		margin-bottom: 1rem;
		border-bottom: 1px solid var(--border);
		padding-bottom: 0;
	}

	.sub-tabs button {
		background: transparent;
		color: var(--muted);
		border: none;
		border-radius: 0;
		padding: 0.5rem 1rem;
		font-size: 14px;
		border-bottom: 2px solid transparent;
		transition: color 0.15s, border-color 0.15s;
		margin-bottom: -1px;
	}

	.sub-tabs button:hover {
		color: var(--text);
	}

	.sub-tabs button.active {
		color: var(--accent2);
		border-bottom-color: var(--accent);
	}

	/* Search row */
	.search-row {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}

	.search-row input {
		flex: 1;
	}

	.search-row select {
		width: auto;
		min-width: 150px;
	}

	/* Category tabs */
	.category-tabs {
		display: flex;
		gap: 0.35rem;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}

	.cat-tab {
		background: var(--surface);
		color: var(--muted);
		border: 1px solid var(--border);
		padding: 0.3rem 0.75rem;
		font-size: 13px;
		font-weight: 500;
		transition: background 0.15s, color 0.15s, border-color 0.15s;
	}

	.cat-tab:hover {
		color: var(--text);
		border-color: var(--accent);
	}

	.cat-tab.active {
		background: var(--accent);
		color: #fff;
		border-color: var(--accent);
	}

	.cat-count {
		display: inline-block;
		background: rgba(255, 255, 255, 0.15);
		padding: 0 5px;
		border-radius: 8px;
		font-size: 11px;
		margin-left: 3px;
	}

	.results-count {
		font-size: 13px;
		margin-bottom: 0.75rem;
	}

	/* Extension card (gallery grid item) */
	.ext-card {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		text-align: left;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
		width: 100%;
		color: var(--text);
	}

	.ext-card:hover {
		border-color: var(--accent);
		background: var(--surface2);
	}

	.ext-card-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	.ext-name {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		line-height: 1.3;
	}

	.ext-desc {
		font-size: 13px;
		color: var(--muted);
		margin: 0 0 0.75rem;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		line-height: 1.4;
	}

	.ext-card-footer {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: auto;
		font-size: 12px;
	}

	.ext-category {
		display: inline-block;
		background: var(--surface2);
		color: var(--accent2);
		padding: 2px 8px;
		border-radius: 10px;
		font-size: 11px;
		font-weight: 600;
		text-transform: capitalize;
	}

	.ext-author {
		font-size: 12px;
	}

	.installed-badge {
		display: inline-block;
		background: var(--green);
		color: #fff;
		padding: 2px 8px;
		border-radius: 10px;
		font-size: 11px;
		font-weight: 600;
	}

	.builtin-badge {
		display: inline-block;
		background: var(--surface2);
		color: var(--muted);
		padding: 2px 8px;
		border-radius: 10px;
		font-size: 11px;
		font-weight: 600;
	}

	/* npm section */
	.npm-notice {
		font-size: 13px;
	}

	.npm-card h3 {
		margin: 0 0 0.25rem;
		font-size: 15px;
	}

	.npm-card p {
		margin: 0;
		font-size: 13px;
	}

	.npm-meta {
		display: flex;
		gap: 0.75rem;
		margin-top: 0.25rem;
		font-size: 12px;
	}

	.npm-actions {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		margin-left: 1rem;
	}

	/* Installed list */
	.installed-card h3 {
		margin: 0;
		font-size: 15px;
		font-family: monospace;
		word-break: break-all;
	}

	/* Detail modal content */
	.detail-content {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.detail-meta-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.detail-risk-info {
		background: var(--surface2);
		border-radius: var(--radius);
		padding: 0.75rem;
	}

	.detail-risk-info strong {
		font-size: 14px;
	}

	.detail-risk-info p {
		margin: 0.25rem 0 0;
		font-size: 13px;
	}

	.detail-section {
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}

	.detail-section h4 {
		margin: 0 0 0.35rem;
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.detail-section p {
		margin: 0;
		font-size: 14px;
		line-height: 1.5;
	}

	.tag-list {
		display: flex;
		gap: 0.35rem;
		flex-wrap: wrap;
	}

	.tag {
		display: inline-block;
		background: var(--surface2);
		color: var(--text);
		padding: 2px 8px;
		border-radius: 10px;
		font-size: 12px;
	}

	.permission-list {
		margin: 0;
		padding-left: 1.2rem;
		font-size: 13px;
	}

	.permission-list li {
		margin-bottom: 0.2rem;
	}

	.security-notes {
		background: rgba(239, 68, 68, 0.08);
		border: 1px solid rgba(239, 68, 68, 0.2);
		border-radius: var(--radius);
		padding: 0.75rem;
		border-top: none;
	}

	.security-notes h4 {
		color: var(--red);
	}

	/* Responsive */
	@media (max-width: 700px) {
		.page-header {
			flex-direction: column;
			align-items: flex-start;
		}

		.search-row {
			flex-direction: column;
		}

		.search-row select {
			width: 100%;
		}

		.category-tabs {
			overflow-x: auto;
			flex-wrap: nowrap;
			-webkit-overflow-scrolling: touch;
			padding-bottom: 0.25rem;
		}

		.cat-tab {
			white-space: nowrap;
			flex-shrink: 0;
		}

		.npm-card .flex-between {
			flex-direction: column;
			align-items: flex-start;
			gap: 0.75rem;
		}

		.npm-actions {
			margin-left: 0;
		}
	}
</style>
