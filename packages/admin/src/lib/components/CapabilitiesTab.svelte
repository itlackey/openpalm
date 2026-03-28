<script lang="ts">
	import { onMount } from 'svelte';
	import { getAdminToken } from '$lib/auth.js';
	import type { OpenCodeProviderSummary, OpenCodeAuthMethod } from '$lib/types.js';
	import {
		fetchCapabilitiesDto,
		fetchAssignments,
		saveAssignments,
		saveCapabilities,
		testCapability,
		resetMemoryCollection,
		detectLocalProviders,
		fetchMemoryConfig,
	} from '$lib/api.js';
	import { PROVIDERS, KNOWN_EMB_DIMS } from '$lib/provider-registry.js';
	import { PROVIDER_KEY_MAP } from '$lib/provider-constants.js';
	import ConnectDetailSheet from './opencode/ConnectDetailSheet.svelte';
	import ModalSheet from './opencode/ModalSheet.svelte';

	interface Props { loading: boolean; onRefresh: () => void; openCodeStatus?: 'checking' | 'ready' | 'unavailable'; }
	let { loading, onRefresh, openCodeStatus = 'checking' }: Props = $props();

	// ── Sub-tab state ───────────────────────────────────────────────
	let activeSubTab = $state<'providers' | 'capabilities' | 'voice' | 'memory'>('providers');

	// ── Page state ──────────────────────────────────────────────────
	let pageLoading = $state(false);
	let loadError = $state('');

	// ── OpenCode state ──────────────────────────────────────────────
	let openCodeAvailable = $derived(openCodeStatus === 'ready');
	type ProviderEntry = OpenCodeProviderSummary & { authMethods: OpenCodeAuthMethod[] };
	let ocProviders = $state<ProviderEntry[]>([]);

	// ── Local providers ─────────────────────────────────────────────
	let detectedLocal = $state<Array<{ provider: string; url: string; available: boolean }>>([]);

	// ── Secrets (for checking which cloud keys are stored) ──────────
	let secrets = $state<Record<string, string>>({});

	// ── Provider models cache ───────────────────────────────────────
	let providerModels = $state<Record<string, string[]>>({});

	// ── Connect flow ────────────────────────────────────────────────
	let connectProvider = $state<ProviderEntry | null>(null);

	// ── Provider search ─────────────────────────────────────────────
	let providerSearch = $state('');

	// ── Custom endpoint form ────────────────────────────────────────
	let customFormOpen = $state(false);
	let customUrl = $state('');
	let customKey = $state('');
	let customTesting = $state(false);
	let customTested = $state(false);
	let customError = $state('');

	// ── Capability fields ───────────────────────────────────────────
	let llmProvider = $state('');
	let llmModel = $state('');
	let slmProvider = $state('');
	let slmModel = $state('');
	let embProvider = $state('');
	let embModel = $state('');
	let embDims = $state(768);
	let ttsProvider = $state('');
	let ttsModel = $state('');
	let ttsVoice = $state('');
	let sttProvider = $state('');
	let sttModel = $state('');
	let sttLanguage = $state('');
	let rerankProvider = $state('');
	let rerankMode = $state<'llm' | 'dedicated'>('llm');
	let rerankModel = $state('');
	let rerankTopK = $state(10);
	let memUserId = $state('default_user');
	let memInstructions = $state('');

	// ── Save state ──────────────────────────────────────────────────
	let saving = $state(false);
	let saveError = $state('');
	let saveSuccess = $state(false);

	// ── Derived: connected providers for capability dropdowns ───────
	let connectedProviders = $derived.by(() => {
		const result: Array<{ id: string; name: string }> = [];
		// Local detected
		for (const d of detectedLocal) {
			if (d.available) {
				const def = PROVIDERS.find((p) => p.id === d.provider);
				if (def) result.push({ id: def.id, name: def.name });
			}
		}
		// OpenCode connected
		for (const p of ocProviders) {
			if (p.connected && !result.some((r) => r.id === p.id)) {
				result.push({ id: p.id, name: p.name });
			}
		}
		// Fallback: cloud connections from secrets (when OpenCode unavailable)
		if (!openCodeAvailable) {
			for (const provDef of PROVIDERS.filter((p) => p.needsKey)) {
				const envKey = PROVIDER_KEY_MAP[provDef.id];
				if (envKey && secrets[envKey] && !result.some((r) => r.id === provDef.id)) {
					result.push({ id: provDef.id, name: provDef.name });
				}
			}
		}
		return result;
	});

	// ── Derived: connected providers list (local + cloud) ───────────
	let activeProviders = $derived.by(() => {
		const result: Array<{ id: string; name: string; kind: 'local' | 'cloud'; detail: string; models: number }> = [];
		for (const d of detectedLocal) {
			if (d.available) {
				const def = PROVIDERS.find((p) => p.id === d.provider);
				result.push({ id: d.provider, name: def?.name ?? d.provider, kind: 'local', detail: d.url, models: (providerModels[d.provider] ?? []).length });
			}
		}
		for (const p of ocProviders) {
			if (p.connected && !result.some((r) => r.id === p.id)) {
				result.push({ id: p.id, name: p.name, kind: 'cloud', detail: `${p.modelCount} models`, models: p.modelCount });
			}
		}
		if (!openCodeAvailable) {
			for (const provDef of PROVIDERS.filter((pd) => pd.needsKey)) {
				const envKey = PROVIDER_KEY_MAP[provDef.id];
				if (envKey && secrets[envKey] && !result.some((r) => r.id === provDef.id)) {
					result.push({ id: provDef.id, name: provDef.name, kind: 'cloud', detail: 'API key stored', models: 0 });
				}
			}
		}
		return result;
	});

	// ── Derived: available (not connected) providers to show ────────
	let availableProviders = $derived.by(() => {
		const connectedIds = new Set(activeProviders.map((p) => p.id));
		if (openCodeAvailable && ocProviders.length > 0) {
			let list = ocProviders.filter((p) => !p.connected && !connectedIds.has(p.id));
			if (providerSearch) {
				const q = providerSearch.toLowerCase();
				list = list.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
			}
			return list;
		}
		// Fallback: show PROVIDERS registry entries when OpenCode unavailable
		return PROVIDERS.filter((p) => p.needsKey && !connectedIds.has(p.id)).map((p) => ({
			id: p.id, name: p.name, connected: false, env: [], modelCount: 0, authMethods: [{ type: 'api' as const, label: 'API Key' }],
		}));
	});

	// ── Load all data ───────────────────────────────────────────────
	async function loadAll(isRefresh = false): Promise<void> {
		const token = getAdminToken();
		if (!token) return;
		if (!isRefresh) pageLoading = true;
		loadError = '';
		try {
			// Fetch everything in parallel — no sequential waits
			const [dto, assign, localResult, memConfig] = await Promise.all([
				fetchCapabilitiesDto(token),
				fetchAssignments(token),
				detectLocalProviders(token).catch((e) => {
					console.warn('[CapabilitiesTab] Failed to detect local providers:', e);
					return { providers: [] };
				}),
				fetchMemoryConfig(token).catch((e) => {
					console.warn('[CapabilitiesTab] Failed to load memory config:', e);
					return null;
				}),
			]);

			secrets = dto.secrets ?? {};
			detectedLocal = localResult.providers ?? [];

			// Parse capability assignments
			const loaded = assign.capabilities as Record<string, unknown> | null;
			if (loaded) {
				const llmStr = (loaded.llm as string) ?? '';
				const s = llmStr.indexOf('/');
				if (s > 0) { llmProvider = llmStr.slice(0, s); llmModel = llmStr.slice(s + 1); }
				const slmStr = (loaded.slm as string) ?? '';
				const s2 = slmStr.indexOf('/');
				if (s2 > 0) { slmProvider = slmStr.slice(0, s2); slmModel = slmStr.slice(s2 + 1); }
				const emb = loaded.embeddings as Record<string, unknown> | undefined;
				embProvider = (emb?.provider as string) ?? '';
				embModel = (emb?.model as string) ?? '';
				embDims = (emb?.dims as number) ?? 768;
				const mem = loaded.memory as Record<string, unknown> | undefined;
				memUserId = (mem?.userId as string) ?? 'default_user';
				memInstructions = (mem?.customInstructions as string) ?? '';
				const tts = loaded.tts as Record<string, unknown> | undefined;
				ttsProvider = (tts?.provider as string) ?? '';
				ttsModel = (tts?.model as string) ?? '';
				ttsVoice = (tts?.voice as string) ?? '';
				const stt = loaded.stt as Record<string, unknown> | undefined;
				sttProvider = (stt?.provider as string) ?? '';
				sttModel = (stt?.model as string) ?? '';
				sttLanguage = (stt?.language as string) ?? '';
				const rr = loaded.reranking as Record<string, unknown> | undefined;
				rerankProvider = (rr?.provider as string) ?? '';
				rerankMode = (rr?.mode as 'llm' | 'dedicated') ?? 'llm';
				rerankModel = (rr?.model as string) ?? '';
				rerankTopK = (rr?.topK as number) ?? 10;
				if (llmProvider && llmModel) activeSubTab = 'capabilities';
			}
			if (memConfig?.config?.memory?.custom_instructions) memInstructions = memConfig.config.memory.custom_instructions;

			// Show UI immediately, load providers and models in background
			pageLoading = false;

			// Background: model probing (doesn't block UI)
			const bgTasks: Promise<void>[] = [];
			if (llmProvider) bgTasks.push(probeModels(llmProvider));
			if (embProvider && embProvider !== llmProvider) bgTasks.push(probeModels(embProvider));
			await Promise.all(bgTasks);
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Failed to load.';
			pageLoading = false;
		}
	}
	onMount(() => { void loadAll(); });

	// Synchronous read of openCodeAvailable ensures this effect re-runs
	// when openCodeStatus changes (e.g. from 'checking' -> 'ready').
	$effect(() => {
		if (openCodeAvailable) void loadOpenCodeProviders();
	});

	// ── Load OpenCode providers ─────────────────────────────────────
	async function loadOpenCodeProviders(): Promise<void> {
		const token = getAdminToken();
		if (!token) return;
		try {
			const res = await fetch('/admin/opencode/providers', {
				headers: { 'x-admin-token': token, 'x-request-id': crypto.randomUUID(), 'x-requested-by': 'ui' },
			});
			if (!res.ok) {
				console.warn('[CapabilitiesTab] Provider fetch returned HTTP', res.status);
				return;
			}
			const data = await res.json();
			ocProviders = data.providers ?? [];
			const pm = { ...providerModels };
			for (const p of ocProviders) {
				if (p.connected && p.models?.length) {
					pm[p.id] = p.models.map((m) => m.id).sort((a, b) => a.localeCompare(b));
				}
			}
			providerModels = pm;
		} catch (e) {
			console.warn('[CapabilitiesTab] Failed to load OpenCode providers:', e);
		}
	}

	// ── Probe models for a provider ─────────────────────────────────
	async function probeModels(id: string): Promise<void> {
		if (providerModels[id]?.length) return;
		// Check if OpenCode already has models for this provider
		const ocProv = ocProviders.find((p) => p.id === id && p.connected);
		if (ocProv?.models?.length) {
			providerModels = { ...providerModels, [id]: ocProv.models.map((m) => m.id).sort((a, b) => a.localeCompare(b)) };
			return;
		}
		// Fall back to probing via test endpoint (local providers, custom endpoints)
		const token = getAdminToken(); if (!token) return;
		const def = PROVIDERS.find((p) => p.id === id);
		const det = detectedLocal.find((d) => d.provider === id && d.available);
		const baseUrl = det?.url || def?.baseUrl; if (!baseUrl) return;
		const envKey = PROVIDER_KEY_MAP[id];
		const apiKey = envKey ? (secrets[envKey] ?? '') : '';
		try {
			const kind = (def?.kind === 'local') ? 'openai_compatible_local' : 'openai_compatible_remote';
			const r = await testCapability(token, { baseUrl, apiKey, kind, provider: id });
			if (r.ok && r.models?.length) providerModels = { ...providerModels, [id]: [...r.models].sort((a, b) => a.localeCompare(b)) };
		} catch (e) {
			console.warn(`[CapabilitiesTab] Failed to probe models for ${id}:`, e);
		}
	}

	function lookupEmbDims(model: string): number {
		if (KNOWN_EMB_DIMS[model]) return KNOWN_EMB_DIMS[model];
		const bare = model.includes(':') ? model.slice(0, model.lastIndexOf(':')) : model;
		return KNOWN_EMB_DIMS[bare] ?? 0;
	}

	// ── Provider connect callback ───────────────────────────────────
	function handleProviderConnected() {
		connectProvider = null;
		void loadAll(true);
	}

	// ── Custom endpoint handlers ────────────────────────────────────
	function resetCustomForm() {
		customFormOpen = false;
		customUrl = '';
		customKey = '';
		customTesting = false;
		customTested = false;
		customError = '';
	}

	async function handleCustomTest(): Promise<void> {
		if (!customUrl.trim()) { customError = 'URL is required.'; return; }
		const token = getAdminToken(); if (!token) return;
		customTesting = true; customTested = false; customError = '';
		try {
			const r = await testCapability(token, { baseUrl: customUrl.trim(), apiKey: customKey, kind: 'openai_compatible_remote', provider: 'openai-compatible' });
			if (r.ok) {
				customTested = true;
				if (r.models?.length) providerModels = { ...providerModels, 'openai-compatible': r.models };
			} else {
				customError = (r as { error?: string }).error ?? 'Connection failed.';
			}
		} catch (e) { customError = e instanceof Error ? e.message : 'Test failed.'; }
		finally { customTesting = false; }
	}

	async function handleCustomSave(): Promise<void> {
		const token = getAdminToken(); if (!token) return;
		try {
			if (customKey) await saveCapabilities(token, { provider: 'openai-compatible', apiKey: customKey });
			resetCustomForm();
			void loadAll(true);
		} catch (e) { customError = e instanceof Error ? e.message : 'Save failed.'; }
	}

	// ── Capability change handlers ──────────────────────────────────
	function onProviderChange(target: 'llm' | 'slm' | 'emb', newVal: string) {
		const def = PROVIDERS.find((p) => p.id === newVal);
		// Probe models first so the dropdown populates
		void probeModels(newVal).then(() => {
			const models = providerModels[newVal] ?? [];
			if (target === 'llm') {
				llmProvider = newVal;
				llmModel = def?.llmModel ?? (models.length > 0 ? models[0] : '');
			} else if (target === 'slm') {
				slmProvider = newVal;
				slmModel = def?.llmModel ?? (models.length > 0 ? models[0] : '');
			} else if (target === 'emb') {
				embProvider = newVal;
				embModel = def?.embModel ?? (models.length > 0 ? models[0] : '');
				if (def?.embDims) embDims = def.embDims;
				else { const d = lookupEmbDims(embModel); if (d) embDims = d; }
			}
		});
		// Set provider immediately so the UI updates
		if (target === 'llm') { llmProvider = newVal; llmModel = def?.llmModel ?? ''; }
		else if (target === 'slm') { slmProvider = newVal; slmModel = def?.llmModel ?? ''; }
		else if (target === 'emb') {
			embProvider = newVal;
			embModel = def?.embModel ?? '';
			if (def?.embDims) embDims = def.embDims;
		}
	}

	function onEmbModelChange(val: string) {
		embModel = val;
		const d = lookupEmbDims(val);
		if (d) embDims = d;
	}

	// ── Save assignments ────────────────────────────────────────────
	async function handleSave(): Promise<void> {
		const token = getAdminToken(); if (!token) return;
		saving = true; saveError = ''; saveSuccess = false;
		try {
			const p: Record<string, unknown> = {
				llm: llmProvider && llmModel ? `${llmProvider}/${llmModel}` : undefined,
				embeddings: embProvider && embModel ? { provider: embProvider, model: embModel, dims: embDims } : undefined,
				memory: { userId: memUserId, customInstructions: memInstructions },
			};
			if (slmProvider && slmModel) p.slm = `${slmProvider}/${slmModel}`; else p.slm = undefined;
			p.tts = ttsProvider ? { enabled: true, provider: ttsProvider, model: ttsModel || undefined, voice: ttsVoice || undefined } : undefined;
			p.stt = sttProvider ? { enabled: true, provider: sttProvider, model: sttModel || undefined, language: sttLanguage || undefined } : undefined;
			p.reranking = rerankProvider ? { enabled: true, provider: rerankProvider, mode: rerankMode, model: rerankModel || undefined, topK: rerankTopK } : undefined;
			await saveAssignments(token, p);
			saveSuccess = true; setTimeout(() => saveSuccess = false, 4000); onRefresh();
		} catch (e) { saveError = e instanceof Error ? e.message : 'Save failed.'; }
		finally { saving = false; }
	}

	async function handleResetMemory(): Promise<void> {
		if (!confirm('Delete all stored memories? This cannot be undone.')) return;
		const token = getAdminToken(); if (!token) return;
		try { await resetMemoryCollection(token); saveSuccess = true; setTimeout(() => saveSuccess = false, 4000); }
		catch (e) { saveError = e instanceof Error ? e.message : 'Reset failed.'; }
	}
</script>

<div class="cap-tab" role="tabpanel">

{#if loadError}
	<div class="error-state">{loadError} <button class="btn btn-secondary btn-sm" onclick={() => void loadAll()}>Retry</button></div>
{/if}

<!-- Sub-tab pills -->
<div class="sub-tabs" role="tablist">
	<button class="pill" class:pill--active={activeSubTab === 'providers'} role="tab" aria-selected={activeSubTab === 'providers'} onclick={() => activeSubTab = 'providers'}>Providers</button>
	<button class="pill" class:pill--active={activeSubTab === 'capabilities'} role="tab" aria-selected={activeSubTab === 'capabilities'} onclick={() => activeSubTab = 'capabilities'}>Capabilities</button>
	<button class="pill" class:pill--active={activeSubTab === 'voice'} role="tab" aria-selected={activeSubTab === 'voice'} onclick={() => activeSubTab = 'voice'}>Voice</button>
	<button class="pill" class:pill--active={activeSubTab === 'memory'} role="tab" aria-selected={activeSubTab === 'memory'} onclick={() => activeSubTab = 'memory'}>Memory</button>
	{#if pageLoading}<span class="loading-hint"><span class="spinner"></span> Loading...</span>{/if}
</div>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- PROVIDERS SUB-TAB                                             -->
<!-- ═══════════════════════════════════════════════════════════════ -->
{#if activeSubTab === 'providers'}
<div class="sub-panel">

	<!-- Your connected providers -->
	<div class="section-block">
		<h3 class="section-heading">Your Providers</h3>
		{#if activeProviders.length > 0}
			<div class="provider-list">
				{#each activeProviders as p}
					<div class="provider-row">
						<span class="provider-dot provider-dot--ok"></span>
						<span class="provider-row-name">{p.name}</span>
						<span class="provider-row-detail">{p.detail}</span>
						<span class="provider-badge" class:provider-badge--local={p.kind === 'local'} class:provider-badge--cloud={p.kind === 'cloud'}>
							{p.kind === 'local' ? 'Local' : 'Cloud'}
						</span>
					</div>
				{/each}
			</div>
		{:else}
			<p class="section-empty">No providers connected yet. Connect one below to get started.</p>
		{/if}
	</div>

	<!-- Connect a provider -->
	<div class="section-block">
		<div class="section-header">
			<h3 class="section-heading">Connect a Provider</h3>
			<input class="search-input" type="search" placeholder="Search providers..." bind:value={providerSearch} />
		</div>

		<div class="provider-grid">
			{#each availableProviders as p (p.id)}
				<button class="provider-card" type="button" onclick={() => connectProvider = p}>
					<span class="provider-card-name">{p.name}</span>
					{#if p.modelCount > 0}
						<span class="provider-card-detail">{p.modelCount} models</span>
					{/if}
				</button>
			{/each}

			<!-- Custom endpoint -->
			<button class="provider-card provider-card--add" type="button" onclick={() => { customFormOpen = !customFormOpen; }}>
				<span class="provider-card-name">Custom Endpoint</span>
				<span class="provider-card-detail">OpenAI-compatible URL</span>
			</button>
		</div>

		{#if availableProviders.length === 0 && providerSearch}
			<p class="section-empty">No providers match "{providerSearch}".</p>
		{/if}
	</div>

	<!-- Custom endpoint form -->
	{#if customFormOpen}
		<div class="custom-form">
			<h3 class="section-heading">Custom Endpoint</h3>
			<p class="section-desc">Connect any OpenAI-compatible API endpoint.</p>
			<div class="form-row">
				<div class="form-field form-field--grow">
					<label class="form-label" for="custom-url">Base URL</label>
					<input id="custom-url" class="form-input" type="text" bind:value={customUrl} placeholder="https://your-endpoint.com/v1" autocomplete="off" />
				</div>
				<div class="form-field form-field--grow">
					<label class="form-label" for="custom-key">API Key <span class="form-optional">(optional)</span></label>
					<input id="custom-key" class="form-input" type="password" bind:value={customKey} placeholder="API key" autocomplete="off" />
				</div>
			</div>
			<div class="form-actions">
				<button class="btn btn-outline btn-sm" disabled={customTesting || !customUrl.trim()} onclick={() => void handleCustomTest()}>
					{#if customTesting}<span class="spinner"></span>{:else}Test Connection{/if}
				</button>
				{#if customTested}
					<button class="btn btn-primary btn-sm" onclick={() => void handleCustomSave()}>Save</button>
				{/if}
				<button class="btn btn-ghost btn-sm" onclick={resetCustomForm}>Cancel</button>
			</div>
			{#if customError}<div class="field-error">{customError}</div>{/if}
		</div>
	{/if}
</div>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- CAPABILITIES SUB-TAB                                          -->
<!-- ═══════════════════════════════════════════════════════════════ -->
{:else if activeSubTab === 'capabilities'}
<div class="sub-panel">

	{#if connectedProviders.length === 0}
		<div class="empty-state">
			<p>No providers connected.</p>
			<button class="btn btn-primary btn-sm" onclick={() => activeSubTab = 'providers'}>Connect a Provider</button>
		</div>
	{:else}

	{#if saveSuccess}<div class="feedback feedback--success"><span>Saved.</span></div>{/if}
	{#if saveError}<div class="feedback feedback--error"><span>{saveError}</span>
		<button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => saveError = ''}>x</button>
	</div>{/if}

	<!-- LLM -->
	<div class="assign-section">
		<h3 class="assign-heading">Language Model <span class="assign-required">required</span></h3>
		<div class="assign-row">
			<div class="form-field">
				<label class="form-label" for="llm-p">Provider</label>
				<select id="llm-p" class="form-input" value={llmProvider} onchange={(e) => onProviderChange('llm', (e.currentTarget as HTMLSelectElement).value)}>
					<option value="">Select...</option>
					{#each connectedProviders as p}<option value={p.id} selected={p.id === llmProvider}>{p.name}</option>{/each}
				</select>
			</div>
			<div class="form-field form-field--grow">
				<label class="form-label" for="llm-m">Model</label>
				{#if (providerModels[llmProvider] ?? []).length > 0}
					<select id="llm-m" class="form-input" bind:value={llmModel}>
						{#if !llmModel || !(providerModels[llmProvider] ?? []).includes(llmModel)}<option value={llmModel || ''}>{llmModel || 'Select...'}</option>{/if}
						{#each providerModels[llmProvider] ?? [] as m}<option value={m}>{m}</option>{/each}
					</select>
				{:else}
					<input id="llm-m" class="form-input" type="text" bind:value={llmModel} placeholder="model name" />
				{/if}
			</div>
		</div>
	</div>

	<!-- SLM -->
	<div class="assign-section">
		<h3 class="assign-heading">Small Language Model <span class="assign-optional">optional</span></h3>
		<div class="assign-row">
			<div class="form-field">
				<label class="form-label" for="slm-p">Provider</label>
				<select id="slm-p" class="form-input" value={slmProvider} onchange={(e) => onProviderChange('slm', (e.currentTarget as HTMLSelectElement).value)}>
					<option value="">None</option>
					{#each connectedProviders as p}<option value={p.id} selected={p.id === slmProvider}>{p.name}</option>{/each}
				</select>
			</div>
			<div class="form-field form-field--grow">
				<label class="form-label" for="slm-m">Model</label>
				{#if (providerModels[slmProvider] ?? []).length > 0}
					<select id="slm-m" class="form-input" bind:value={slmModel}>
						{#if !slmModel || !(providerModels[slmProvider] ?? []).includes(slmModel)}<option value={slmModel || ''}>{slmModel || 'Select...'}</option>{/if}
						{#each providerModels[slmProvider] ?? [] as m}<option value={m}>{m}</option>{/each}
					</select>
				{:else}
					<input id="slm-m" class="form-input" type="text" bind:value={slmModel} placeholder="model name" />
				{/if}
			</div>
		</div>
	</div>

	<!-- Embeddings -->
	<div class="assign-section">
		<h3 class="assign-heading">Embeddings <span class="assign-required">required</span></h3>
		<div class="assign-row">
			<div class="form-field">
				<label class="form-label" for="emb-p">Provider</label>
				<select id="emb-p" class="form-input" value={embProvider} onchange={(e) => onProviderChange('emb', (e.currentTarget as HTMLSelectElement).value)}>
					<option value="">Select...</option>
					{#each connectedProviders as p}<option value={p.id} selected={p.id === embProvider}>{p.name}</option>{/each}
				</select>
			</div>
			<div class="form-field form-field--grow">
				<label class="form-label" for="emb-m">Model</label>
				{#if (providerModels[embProvider] ?? []).length > 0}
					<select id="emb-m" class="form-input" bind:value={embModel} onchange={(e) => { const d = lookupEmbDims((e.currentTarget as HTMLSelectElement).value); if (d) embDims = d; }}>
						{#if !embModel || !(providerModels[embProvider] ?? []).includes(embModel)}<option value={embModel || ''}>{embModel || 'Select...'}</option>{/if}
						{#each providerModels[embProvider] ?? [] as m}<option value={m}>{m}</option>{/each}
					</select>
				{:else}
					<input id="emb-m" class="form-input" type="text" value={embModel} oninput={(e) => onEmbModelChange((e.currentTarget as HTMLInputElement).value)} placeholder="nomic-embed-text" />
				{/if}
			</div>
			<div class="form-field form-field--narrow">
				<label class="form-label" for="emb-d">Dims</label>
				<input id="emb-d" class="form-input" type="number" bind:value={embDims} min="1" max="8192" />
			</div>
		</div>
	</div>

	<!-- Reranking — directly under embeddings -->
	<div class="assign-section">
		<h3 class="assign-heading">Reranking <span class="assign-optional">optional</span></h3>
		<p class="section-desc">Re-rank search results for better relevance. Leave empty to disable.</p>
		<div class="assign-row">
			<div class="form-field">
				<label class="form-label" for="rr-p">Provider</label>
				<select id="rr-p" class="form-input" bind:value={rerankProvider} onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v) void probeModels(v); rerankModel = ''; }}>
					<option value="">None</option>
					{#each connectedProviders as p}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</div>
			<div class="form-field">
				<label class="form-label" for="rr-mode">Mode</label>
				<select id="rr-mode" class="form-input" bind:value={rerankMode}>
					<option value="llm">Use LLM</option>
					<option value="dedicated">Dedicated model</option>
				</select>
			</div>
			<div class="form-field form-field--grow">
				<label class="form-label" for="rr-m">Model</label>
				{#if rerankProvider && (providerModels[rerankProvider] ?? []).length > 0}
					<select id="rr-m" class="form-input" bind:value={rerankModel}>
						<option value="">Select...</option>
						{#each providerModels[rerankProvider] ?? [] as m}<option value={m}>{m}</option>{/each}
					</select>
				{:else}
					<input id="rr-m" class="form-input" type="text" bind:value={rerankModel} placeholder={rerankMode === 'dedicated' ? 'reranker model' : 'optional'} />
				{/if}
			</div>
			<div class="form-field form-field--narrow">
				<label class="form-label" for="rr-k">Top K</label>
				<input id="rr-k" class="form-input" type="number" bind:value={rerankTopK} min="1" max="100" />
			</div>
		</div>
	</div>

	<!-- Save -->
	<div class="save-footer">
		<button class="btn btn-primary" onclick={() => void handleSave()} disabled={saving || !llmProvider || !llmModel}>
			{#if saving}<span class="spinner"></span>{/if} Save Changes
		</button>
	</div>

	{/if}
</div>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- VOICE SUB-TAB                                                 -->
<!-- ═══════════════════════════════════════════════════════════════ -->
{:else if activeSubTab === 'voice'}
<div class="sub-panel">

	{#if saveSuccess}<div class="feedback feedback--success"><span>Saved.</span></div>{/if}
	{#if saveError}<div class="feedback feedback--error"><span>{saveError}</span>
		<button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => saveError = ''}>x</button>
	</div>{/if}

	<div class="assign-section">
		<h3 class="assign-heading">Text-to-Speech</h3>
		<p class="section-desc">Generate audio from assistant responses. Set a provider and model to enable. Leave empty to disable.</p>
		<div class="assign-row">
			<div class="form-field">
				<label class="form-label" for="tts-p">Provider</label>
				<select id="tts-p" class="form-input" bind:value={ttsProvider} onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v) void probeModels(v); ttsModel = ''; }}>
					<option value="">None</option>
					{#each connectedProviders as p}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</div>
			<div class="form-field">
				<label class="form-label" for="tts-m">Model</label>
				{#if ttsProvider && (providerModels[ttsProvider] ?? []).length > 0}
					<select id="tts-m" class="form-input" bind:value={ttsModel}>
						<option value="">Select...</option>
						{#each providerModels[ttsProvider] ?? [] as m}<option value={m}>{m}</option>{/each}
					</select>
				{:else}
					<input id="tts-m" class="form-input" type="text" bind:value={ttsModel} placeholder="tts-1" />
				{/if}
			</div>
			<div class="form-field">
				<label class="form-label" for="tts-v">Voice</label>
				<input id="tts-v" class="form-input" type="text" bind:value={ttsVoice} placeholder="alloy" />
			</div>
		</div>
	</div>

	<div class="assign-section">
		<h3 class="assign-heading">Speech-to-Text</h3>
		<p class="section-desc">Transcribe audio input from users. Set a provider and model to enable. Leave empty to disable.</p>
		<div class="assign-row">
			<div class="form-field">
				<label class="form-label" for="stt-p">Provider</label>
				<select id="stt-p" class="form-input" bind:value={sttProvider} onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v) void probeModels(v); sttModel = ''; }}>
					<option value="">None</option>
					{#each connectedProviders as p}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</div>
			<div class="form-field">
				<label class="form-label" for="stt-m">Model</label>
				{#if sttProvider && (providerModels[sttProvider] ?? []).length > 0}
					<select id="stt-m" class="form-input" bind:value={sttModel}>
						<option value="">Select...</option>
						{#each providerModels[sttProvider] ?? [] as m}<option value={m}>{m}</option>{/each}
					</select>
				{:else}
					<input id="stt-m" class="form-input" type="text" bind:value={sttModel} placeholder="whisper-1" />
				{/if}
			</div>
			<div class="form-field">
				<label class="form-label" for="stt-l">Language</label>
				<input id="stt-l" class="form-input" type="text" bind:value={sttLanguage} placeholder="en" />
			</div>
		</div>
	</div>

	<div class="save-footer">
		<button class="btn btn-primary" onclick={() => void handleSave()} disabled={saving}>
			{#if saving}<span class="spinner"></span>{/if} Save Changes
		</button>
	</div>
</div>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- MEMORY SUB-TAB                                                -->
<!-- ═══════════════════════════════════════════════════════════════ -->
{:else if activeSubTab === 'memory'}
<div class="sub-panel">

	{#if saveSuccess}<div class="feedback feedback--success"><span>Saved.</span></div>{/if}
	{#if saveError}<div class="feedback feedback--error"><span>{saveError}</span>
		<button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => saveError = ''}>x</button>
	</div>{/if}

	<div class="assign-section">
		<h3 class="assign-heading">Memory Settings</h3>
		<p class="section-desc">The assistant uses memory to remember context across conversations.</p>
		<div class="assign-row">
			<div class="form-field" style="max-width: 240px">
				<label class="form-label" for="mem-u">User ID</label>
				<input id="mem-u" class="form-input" type="text" bind:value={memUserId} />
				<span class="form-hint">Identifies your memory collection</span>
			</div>
		</div>
		<div class="assign-row">
			<div class="form-field form-field--grow">
				<label class="form-label" for="mem-i">Custom Instructions</label>
				<textarea id="mem-i" class="form-input form-textarea" bind:value={memInstructions} rows="4" placeholder="Optional instructions that guide how the assistant stores and recalls memories"></textarea>
			</div>
		</div>
	</div>

	<div class="save-footer">
		<div class="save-footer-left">
			<button class="btn btn-danger btn-sm" onclick={() => void handleResetMemory()}>Reset Memory Collection</button>
			<span class="form-hint">Permanently deletes all stored memories.</span>
		</div>
		<button class="btn btn-primary" onclick={() => void handleSave()} disabled={saving}>
			{#if saving}<span class="spinner"></span>{/if} Save Changes
		</button>
	</div>
</div>
{/if}
</div>

<!-- Connect provider sheet -->
{#if connectProvider}
	<ConnectDetailSheet
		open={!!connectProvider}
		provider={connectProvider}
		onBack={() => connectProvider = null}
		onConnected={handleProviderConnected}
		onClose={() => connectProvider = null}
	/>
{/if}

<style>
	.cap-tab { display: flex; flex-direction: column; gap: var(--space-4); }

	/* ── Sub-tab pills ──────────────────────────────────────────── */
	.sub-tabs { display: flex; align-items: center; gap: var(--space-2); padding-bottom: var(--space-1); }
	.loading-hint { display: inline-flex; align-items: center; gap: var(--space-2); margin-left: auto; font-size: var(--text-xs); color: var(--color-text-tertiary); }

	/* ── Sub-panel ──────────────────────────────────────────────── */
	.sub-panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: var(--space-5); }

	/* ── Section blocks ─────────────────────────────────────────── */
	.section-block { margin-bottom: var(--space-5); }
	.section-block:last-child { margin-bottom: 0; }
	.section-heading { font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text); margin-bottom: var(--space-3); }
	.section-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); }
	.section-header .section-heading { margin-bottom: 0; }
	.section-empty { font-size: var(--text-sm); color: var(--color-text-tertiary); }
	.section-desc { font-size: var(--text-xs); color: var(--color-text-tertiary); margin-bottom: var(--space-3); }

	/* ── Search ─────────────────────────────────────────────────── */
	.search-input { width: 200px; height: 32px; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0 var(--space-3); background: var(--color-bg); color: var(--color-text); font-size: var(--text-sm); font-family: inherit; }
	.search-input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-primary-subtle); }

	/* ── Connected provider list ────────────────────────────────── */
	.provider-list { border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; }
	.provider-row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-bg-tertiary); font-size: var(--text-sm); }
	.provider-row:last-child { border-bottom: none; }
	.provider-row-name { font-weight: var(--font-medium); color: var(--color-text); }
	.provider-row-detail { font-size: var(--text-xs); color: var(--color-text-tertiary); flex: 1; }

	.provider-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.provider-dot--ok { background: var(--color-success); }

	.provider-badge {
		font-size: 10px; font-weight: var(--font-semibold); padding: 1px 6px;
		border-radius: var(--radius-full); text-transform: uppercase; letter-spacing: 0.03em;
		background: var(--color-bg-tertiary); color: var(--color-text-tertiary);
	}
	.provider-badge--local { background: rgba(64, 192, 87, 0.1); color: var(--color-success); }
	.provider-badge--cloud { background: var(--color-info-bg); color: var(--color-info); }

	/* ── Provider grid (available to connect) ───────────────────── */
	.provider-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--space-2); }

	.provider-card {
		display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
		padding: var(--space-3); min-height: 64px;
		background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md);
		cursor: pointer; text-align: center; font-family: inherit;
		transition: border-color var(--transition-fast), background var(--transition-fast);
	}
	.provider-card:hover { border-color: var(--color-primary); background: var(--color-primary-subtle); }
	.provider-card--add { border-style: dashed; }

	.provider-card-name { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); }
	.provider-card-detail { font-size: var(--text-xs); color: var(--color-text-tertiary); }


	/* ── Custom form ────────────────────────────────────────────── */
	.custom-form { margin-top: var(--space-4); padding: var(--space-4); background: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
	.form-row { display: flex; align-items: flex-end; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-3); }
	.form-row:last-child { margin-bottom: 0; }
	.form-field { display: flex; flex-direction: column; gap: var(--space-1); flex: 1; min-width: 140px; }
	.form-field--grow { flex: 2; min-width: 180px; }
	.form-field--narrow { flex: 0 0 100px; min-width: 80px; }
	.form-actions { display: flex; align-items: center; gap: var(--space-2); }
	.form-optional { font-weight: normal; color: var(--color-text-tertiary); }
	.form-hint { font-size: var(--text-xs); color: var(--color-text-tertiary); }
	.field-error { font-size: var(--text-xs); color: var(--color-danger); margin-top: var(--space-2); }

	/* ── Assignment sections ────────────────────────────────────── */
	.assign-section { margin-bottom: var(--space-4); }
	.assign-heading { font-size: var(--text-xs); font-weight: var(--font-semibold); text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text); margin-bottom: var(--space-2); }
	.assign-required { color: var(--color-danger); font-weight: normal; text-transform: none; letter-spacing: normal; }
	.assign-optional { color: var(--color-text-tertiary); font-weight: normal; text-transform: none; letter-spacing: normal; }
	.assign-row { display: flex; align-items: flex-end; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-2); }




	/* ── Form extras ────────────────────────────────────────────── */
	.form-textarea { height: auto; padding: var(--space-2) var(--space-3); resize: vertical; }

	/* ── Save footer ────────────────────────────────────────────── */
	.save-footer { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--color-border); display: flex; justify-content: flex-end; align-items: center; gap: var(--space-3); }
	.save-footer-left { display: flex; align-items: center; gap: var(--space-3); margin-right: auto; }

	/* ── Feedback ────────────────────────────────────────────────── */
	.feedback { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); font-size: var(--text-sm); border-radius: var(--radius-md); margin-bottom: var(--space-4); }
	.feedback span { flex: 1; }
	.feedback--success { background: var(--color-success-bg); color: var(--color-text); }
	.feedback--error { background: var(--color-danger-bg); color: var(--color-text); }
	.btn-dismiss { background: none; border: none; color: inherit; cursor: pointer; opacity: 0.6; font-size: var(--text-sm); }
	.btn-dismiss:hover { opacity: 1; }

	/* ── States ──────────────────────────────────────────────────── */
	.error-state { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-4) var(--space-5); font-size: var(--text-sm); color: var(--color-danger); }
	.empty-state { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-8); color: var(--color-text-tertiary); text-align: center; }
	.empty-state p { font-size: var(--text-sm); }

	/* ── Buttons (scoped fallbacks) ──────────────────────────────── */
	.btn { display: inline-flex; align-items: center; gap: var(--space-2); padding: 8px 16px; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: var(--font-semibold); line-height: 1.4; border: 1px solid transparent; border-radius: var(--radius-md); cursor: pointer; transition: all var(--transition-fast); white-space: nowrap; }
	.btn:disabled { opacity: 0.55; cursor: not-allowed; }
	.btn-primary { background: var(--color-primary); color: #000; border-color: var(--color-primary); }
	.btn-primary:hover:not(:disabled) { background: var(--color-primary-hover); }
	.btn-secondary { background: var(--color-bg); color: var(--color-text); border-color: var(--color-border); }
	.btn-secondary:hover:not(:disabled) { background: var(--color-surface-hover); }
	.btn-outline { background: transparent; color: var(--color-primary); border-color: var(--color-primary); }
	.btn-outline:hover:not(:disabled) { background: var(--color-primary-subtle); }
	.btn-danger { background: var(--color-danger); color: #fff; border-color: var(--color-danger); }
	.btn-danger:hover:not(:disabled) { opacity: 0.9; }
	.btn-ghost { background: none; border: none; color: var(--color-text-secondary); padding: 6px 12px; cursor: pointer; }
	.btn-ghost:hover:not(:disabled) { color: var(--color-text); background: var(--color-bg-secondary); }
	.btn-sm { padding: 5px 12px; font-size: var(--text-xs); }

	.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }

	@media (max-width: 640px) {
		.provider-grid { grid-template-columns: 1fr; }
		.form-row, .assign-row { flex-direction: column; }
		.form-field, .form-field--grow, .form-field--narrow { min-width: unset; max-width: none; }
	}
	@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
