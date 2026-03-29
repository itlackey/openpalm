<script lang="ts">
	import { onMount } from 'svelte';
	import { getAdminToken } from '$lib/auth.js';
	import type { OpenCodeProviderSummary, OpenCodeAuthMethod } from '$lib/types.js';
	import {
		buildHeaders,
		fetchAssignments,
		saveAssignments,
		resetMemoryCollection,
		fetchMemoryConfig,
	} from '$lib/api.js';

	type ProviderEntry = OpenCodeProviderSummary & { authMethods: OpenCodeAuthMethod[] };

	const KNOWN_EMB_DIMS: Record<string, number> = {
		'text-embedding-3-small': 1536,
		'text-embedding-3-large': 3072,
		'text-embedding-ada-002': 1536,
		'nomic-embed-text': 768,
		'mxbai-embed-large': 1024,
		'mxbai-embed-large-v1': 1024,
		'ai/mxbai-embed-large-v1': 1024,
		'mistral-embed': 1024,
		'all-minilm': 384,
		'snowflake-arctic-embed': 1024,
		'intfloat/multilingual-e5-large': 1024,
	};

	interface Props { loading: boolean; onRefresh: () => void; openCodeStatus?: 'checking' | 'ready' | 'unavailable'; }
	let { loading, onRefresh }: Props = $props();

	// ── Sub-tab state ───────────────────────────────────────────────
	let activeSubTab = $state<'capabilities' | 'voice' | 'memory'>('capabilities');

	// ── Page state ──────────────────────────────────────────────────
	let pageLoading = $state(false);
	let loadError = $state('');

	// ── Provider state (for capability dropdowns) ───────────────────
	let ocProviders = $state<ProviderEntry[]>([]);
	let providerModels = $state<Record<string, string[]>>({});

	// ── Capability fields ───────────────────────────────────────────
	let caps = $state({
		llm: { provider: '', model: '' },
		slm: { provider: '', model: '' },
		embeddings: { provider: '', model: '', dims: 768 },
		tts: { provider: '', model: '', voice: '' },
		stt: { provider: '', model: '', language: '' },
		reranking: { provider: '', mode: 'llm' as 'llm' | 'dedicated', model: '', topK: 10 },
		memory: { userId: 'default_user', instructions: '' },
	});

	// ── Save state ──────────────────────────────────────────────────
	let saving = $state(false);
	let saveError = $state('');
	let saveSuccess = $state(false);

	// ── Derived: connected providers ─────────────────────────────────
	// Include any provider currently assigned to a capability (so the dropdown always shows the saved value)
	let connectedProviders = $derived.by(() => {
		const result = ocProviders.filter((p) => p.connected).map((p) => ({ id: p.id, name: p.name }));
		const ids = new Set(result.map((p) => p.id));
		for (const id of [caps.llm.provider, caps.slm.provider, caps.embeddings.provider, caps.tts.provider, caps.stt.provider, caps.reranking.provider]) {
			if (id && !ids.has(id)) { result.push({ id, name: id }); ids.add(id); }
		}
		return result;
	});

	// ── Load data ───────────────────────────────────────────────────
	async function loadProviderDropdowns(): Promise<void> {
		const token = getAdminToken();
		if (!token) return;
		try {
			const res = await fetch('/admin/opencode/providers', { headers: buildHeaders(token) });
			if (!res.ok) return;
			const data = await res.json();
			ocProviders = data.providers ?? [];
			const pm: Record<string, string[]> = {};
			for (const p of ocProviders) {
				if (p.connected && p.models?.length) {
					pm[p.id] = p.models.map((m: { id: string }) => m.id).sort((a: string, b: string) => a.localeCompare(b));
				}
			}
			providerModels = pm;
		} catch {
			// OpenCode unavailable
		}
	}

	async function loadCapabilities(): Promise<void> {
		const token = getAdminToken();
		if (!token) return;
		try {
			const res = await fetchAssignments(token);
			const loaded = res.capabilities as Record<string, unknown> | null;
			if (!loaded) return;
			const llmStr = (loaded.llm as string) ?? '';
			const s = llmStr.indexOf('/');
			if (s > 0) { caps.llm.provider = llmStr.slice(0, s); caps.llm.model = llmStr.slice(s + 1); }
			const slmStr = (loaded.slm as string) ?? '';
			const s2 = slmStr.indexOf('/');
			if (s2 > 0) { caps.slm.provider = slmStr.slice(0, s2); caps.slm.model = slmStr.slice(s2 + 1); }
			const emb = loaded.embeddings as Record<string, unknown> | undefined;
			caps.embeddings.provider = (emb?.provider as string) ?? '';
			caps.embeddings.model = (emb?.model as string) ?? '';
			caps.embeddings.dims = (emb?.dims as number) ?? 768;
			const mem = loaded.memory as Record<string, unknown> | undefined;
			caps.memory.userId = (mem?.userId as string) ?? 'default_user';
			caps.memory.instructions = (mem?.customInstructions as string) ?? '';
			const tts = loaded.tts as Record<string, unknown> | undefined;
			caps.tts.provider = (tts?.provider as string) ?? '';
			caps.tts.model = (tts?.model as string) ?? '';
			caps.tts.voice = (tts?.voice as string) ?? '';
			const stt = loaded.stt as Record<string, unknown> | undefined;
			caps.stt.provider = (stt?.provider as string) ?? '';
			caps.stt.model = (stt?.model as string) ?? '';
			caps.stt.language = (stt?.language as string) ?? '';
			const rr = loaded.reranking as Record<string, unknown> | undefined;
			caps.reranking.provider = (rr?.provider as string) ?? '';
			caps.reranking.mode = (rr?.mode as 'llm' | 'dedicated') ?? 'llm';
			caps.reranking.model = (rr?.model as string) ?? '';
			caps.reranking.topK = (rr?.topK as number) ?? 10;
		} catch {
			// will show empty state
		}
	}

	async function loadMemoryConfig(): Promise<void> {
		const token = getAdminToken();
		if (!token) return;
		try {
			const memConfig = await fetchMemoryConfig(token);
			if (memConfig?.config?.memory?.custom_instructions) caps.memory.instructions = memConfig.config.memory.custom_instructions;
		} catch {
			// optional
		}
	}

	async function loadAll(): Promise<void> {
		pageLoading = true;
		loadError = '';
		try {
			await loadProviderDropdowns();
			await loadCapabilities();
			await loadMemoryConfig();
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Failed to load.';
		} finally {
			pageLoading = false;
		}
	}
	onMount(() => { void loadAll(); });

	function lookupEmbDims(model: string): number {
		if (KNOWN_EMB_DIMS[model]) return KNOWN_EMB_DIMS[model];
		const bare = model.includes(':') ? model.slice(0, model.lastIndexOf(':')) : model;
		return KNOWN_EMB_DIMS[bare] ?? 0;
	}

	// ── Capability change handlers ──────────────────────────────────
	function onProviderChange(target: 'llm' | 'slm' | 'emb', newVal: string) {
		const models = providerModels[newVal] ?? [];
		const first = models.length > 0 ? models[0] : '';
		if (target === 'llm') { caps.llm.provider = newVal; caps.llm.model = first; }
		else if (target === 'slm') { caps.slm.provider = newVal; caps.slm.model = first; }
		else if (target === 'emb') {
			caps.embeddings.provider = newVal;
			caps.embeddings.model = first;
			const d = lookupEmbDims(first); if (d) caps.embeddings.dims = d;
		}
	}

	function onEmbModelChange(val: string) {
		caps.embeddings.model = val;
		const d = lookupEmbDims(val);
		if (d) caps.embeddings.dims = d;
	}

	// ── Save assignments ────────────────────────────────────────────
	async function handleSave(): Promise<void> {
		const token = getAdminToken(); if (!token) return;
		saving = true; saveError = ''; saveSuccess = false;
		try {
			const { llm, slm, embeddings: emb, tts, stt, reranking: rr, memory: mem } = caps;
			const p: Record<string, unknown> = {
				llm: llm.provider && llm.model ? `${llm.provider}/${llm.model}` : undefined,
				slm: slm.provider && slm.model ? `${slm.provider}/${slm.model}` : undefined,
				embeddings: emb.provider && emb.model ? { provider: emb.provider, model: emb.model, dims: emb.dims } : undefined,
				memory: { userId: mem.userId, customInstructions: mem.instructions },
				tts: tts.provider ? { enabled: true, provider: tts.provider, model: tts.model || undefined, voice: tts.voice || undefined } : undefined,
				stt: stt.provider ? { enabled: true, provider: stt.provider, model: stt.model || undefined, language: stt.language || undefined } : undefined,
				reranking: rr.provider ? { enabled: true, provider: rr.provider, mode: rr.mode, model: rr.model || undefined, topK: rr.topK } : undefined,
			};
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
	<button class="pill" class:pill--active={activeSubTab === 'capabilities'} role="tab" aria-selected={activeSubTab === 'capabilities'} onclick={() => activeSubTab = 'capabilities'}>Capabilities</button>
	<button class="pill" class:pill--active={activeSubTab === 'voice'} role="tab" aria-selected={activeSubTab === 'voice'} onclick={() => activeSubTab = 'voice'}>Voice</button>
	<button class="pill" class:pill--active={activeSubTab === 'memory'} role="tab" aria-selected={activeSubTab === 'memory'} onclick={() => activeSubTab = 'memory'}>Memory</button>
	{#if pageLoading}<span class="loading-hint"><span class="spinner"></span> Loading...</span>{/if}
</div>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- CAPABILITIES SUB-TAB                                          -->
<!-- ═══════════════════════════════════════════════════════════════ -->
{#if activeSubTab === 'capabilities'}
<div class="sub-panel">

	{#if connectedProviders.length === 0}
		<div class="empty-state">
			<p>No providers connected. Use the Connections tab to add providers.</p>
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
				<select id="llm-p" name="llm-p" autocomplete="off" class="form-input" value={caps.llm.provider} onchange={(e) => onProviderChange('llm', (e.currentTarget as HTMLSelectElement).value)}>
					<option value="">Select...</option>
					{#each connectedProviders as p}<option value={p.id} selected={p.id === caps.llm.provider}>{p.name}</option>{/each}
				</select>
			</div>
			<div class="form-field form-field--grow">
				<label class="form-label" for="llm-m">Model</label>
				{#if (providerModels[caps.llm.provider] ?? []).length > 0}
					<select id="llm-m" name="llm-m" autocomplete="off" class="form-input" bind:value={caps.llm.model}>
						{#if !caps.llm.model || !(providerModels[caps.llm.provider] ?? []).includes(caps.llm.model)}<option value={caps.llm.model || ''}>{caps.llm.model || 'Select...'}</option>{/if}
						{#each providerModels[caps.llm.provider] ?? [] as m}<option value={m}>{m}</option>{/each}
					</select>
				{:else}
					<input id="llm-m" name="llm-m" autocomplete="off" class="form-input" type="text" bind:value={caps.llm.model} placeholder="model name" />
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
				<select id="slm-p" name="slm-p" autocomplete="off" class="form-input" value={caps.slm.provider} onchange={(e) => onProviderChange('slm', (e.currentTarget as HTMLSelectElement).value)}>
					<option value="">None</option>
					{#each connectedProviders as p}<option value={p.id} selected={p.id === caps.slm.provider}>{p.name}</option>{/each}
				</select>
			</div>
			<div class="form-field form-field--grow">
				<label class="form-label" for="slm-m">Model</label>
				{#if (providerModels[caps.slm.provider] ?? []).length > 0}
					<select id="slm-m" name="slm-m" autocomplete="off" class="form-input" bind:value={caps.slm.model}>
						{#if !caps.slm.model || !(providerModels[caps.slm.provider] ?? []).includes(caps.slm.model)}<option value={caps.slm.model || ''}>{caps.slm.model || 'Select...'}</option>{/if}
						{#each providerModels[caps.slm.provider] ?? [] as m}<option value={m}>{m}</option>{/each}
					</select>
				{:else}
					<input id="slm-m" name="slm-m" autocomplete="off" class="form-input" type="text" bind:value={caps.slm.model} placeholder="model name" />
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
				<select id="emb-p" name="emb-p" autocomplete="off" class="form-input" value={caps.embeddings.provider} onchange={(e) => onProviderChange('emb', (e.currentTarget as HTMLSelectElement).value)}>
					<option value="">Select...</option>
					{#each connectedProviders as p}<option value={p.id} selected={p.id === caps.embeddings.provider}>{p.name}</option>{/each}
				</select>
			</div>
			<div class="form-field form-field--grow">
				<label class="form-label" for="emb-m">Model</label>
				{#if (providerModels[caps.embeddings.provider] ?? []).length > 0}
					<select id="emb-m" name="emb-m" autocomplete="off" class="form-input" bind:value={caps.embeddings.model} onchange={(e) => { const d = lookupEmbDims((e.currentTarget as HTMLSelectElement).value); if (d) caps.embeddings.dims = d; }}>
						{#if !caps.embeddings.model || !(providerModels[caps.embeddings.provider] ?? []).includes(caps.embeddings.model)}<option value={caps.embeddings.model || ''}>{caps.embeddings.model || 'Select...'}</option>{/if}
						{#each providerModels[caps.embeddings.provider] ?? [] as m}<option value={m}>{m}</option>{/each}
					</select>
				{:else}
					<input id="emb-m" name="emb-m" autocomplete="off" class="form-input" type="text" value={caps.embeddings.model} oninput={(e) => onEmbModelChange((e.currentTarget as HTMLInputElement).value)} placeholder="nomic-embed-text" />
				{/if}
			</div>
			<div class="form-field form-field--narrow">
				<label class="form-label" for="emb-d">Dims</label>
				<input id="emb-d" name="emb-d" autocomplete="off" class="form-input" type="number" bind:value={caps.embeddings.dims} min="1" max="8192" />
			</div>
		</div>
	</div>

	<!-- Reranking -->
	<div class="assign-section">
		<h3 class="assign-heading">Reranking <span class="assign-optional">optional</span></h3>
		<p class="section-desc">Re-rank search results for better relevance. Leave empty to disable.</p>
		<div class="assign-row">
			<div class="form-field">
				<label class="form-label" for="rr-p">Provider</label>
				<select id="rr-p" name="rr-p" autocomplete="off" class="form-input" bind:value={caps.reranking.provider} onchange={() => { caps.reranking.model = ''; }}>
					<option value="">None</option>
					{#each connectedProviders as p}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</div>
			<div class="form-field">
				<label class="form-label" for="rr-mode">Mode</label>
				<select id="rr-mode" name="rr-mode" autocomplete="off" class="form-input" bind:value={caps.reranking.mode}>
					<option value="llm">Use LLM</option>
					<option value="dedicated">Dedicated model</option>
				</select>
			</div>
			<div class="form-field form-field--grow">
				<label class="form-label" for="rr-m">Model</label>
				{#if caps.reranking.provider && (providerModels[caps.reranking.provider] ?? []).length > 0}
					<select id="rr-m" name="rr-m" autocomplete="off" class="form-input" bind:value={caps.reranking.model}>
						<option value="">Select...</option>
						{#each providerModels[caps.reranking.provider] ?? [] as m}<option value={m}>{m}</option>{/each}
					</select>
				{:else}
					<input id="rr-m" name="rr-m" autocomplete="off" class="form-input" type="text" bind:value={caps.reranking.model} placeholder={caps.reranking.mode === 'dedicated' ? 'reranker model' : 'optional'} />
				{/if}
			</div>
			<div class="form-field form-field--narrow">
				<label class="form-label" for="rr-k">Top K</label>
				<input id="rr-k" name="rr-k" autocomplete="off" class="form-input" type="number" bind:value={caps.reranking.topK} min="1" max="100" />
			</div>
		</div>
	</div>

	<!-- Save -->
	<div class="save-footer">
		<button class="btn btn-primary" onclick={() => void handleSave()} disabled={saving || !caps.llm.provider || !caps.llm.model}>
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
				<select id="tts-p" name="tts-p" autocomplete="off" class="form-input" bind:value={caps.tts.provider} onchange={() => { caps.tts.model = ''; }}>
					<option value="">None</option>
					{#each connectedProviders as p}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</div>
			<div class="form-field">
				<label class="form-label" for="tts-m">Model</label>
				{#if caps.tts.provider && (providerModels[caps.tts.provider] ?? []).length > 0}
					<select id="tts-m" name="tts-m" autocomplete="off" class="form-input" bind:value={caps.tts.model}>
						<option value="">Select...</option>
						{#each providerModels[caps.tts.provider] ?? [] as m}<option value={m}>{m}</option>{/each}
					</select>
				{:else}
					<input id="tts-m" name="tts-m" autocomplete="off" class="form-input" type="text" bind:value={caps.tts.model} placeholder="tts-1" />
				{/if}
			</div>
			<div class="form-field">
				<label class="form-label" for="tts-v">Voice</label>
				<input id="tts-v" name="tts-v" autocomplete="off" class="form-input" type="text" bind:value={caps.tts.voice} placeholder="alloy" />
			</div>
		</div>
	</div>

	<div class="assign-section">
		<h3 class="assign-heading">Speech-to-Text</h3>
		<p class="section-desc">Transcribe audio input from users. Set a provider and model to enable. Leave empty to disable.</p>
		<div class="assign-row">
			<div class="form-field">
				<label class="form-label" for="stt-p">Provider</label>
				<select id="stt-p" name="stt-p" autocomplete="off" class="form-input" bind:value={caps.stt.provider} onchange={() => { caps.stt.model = ''; }}>
					<option value="">None</option>
					{#each connectedProviders as p}<option value={p.id}>{p.name}</option>{/each}
				</select>
			</div>
			<div class="form-field">
				<label class="form-label" for="stt-m">Model</label>
				{#if caps.stt.provider && (providerModels[caps.stt.provider] ?? []).length > 0}
					<select id="stt-m" name="stt-m" autocomplete="off" class="form-input" bind:value={caps.stt.model}>
						<option value="">Select...</option>
						{#each providerModels[caps.stt.provider] ?? [] as m}<option value={m}>{m}</option>{/each}
					</select>
				{:else}
					<input id="stt-m" name="stt-m" autocomplete="off" class="form-input" type="text" bind:value={caps.stt.model} placeholder="whisper-1" />
				{/if}
			</div>
			<div class="form-field">
				<label class="form-label" for="stt-l">Language</label>
				<input id="stt-l" name="stt-l" autocomplete="off" class="form-input" type="text" bind:value={caps.stt.language} placeholder="en" />
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
				<input id="mem-u" name="mem-u" autocomplete="off" class="form-input" type="text" bind:value={caps.memory.userId} />
				<span class="form-hint">Identifies your memory collection</span>
			</div>
		</div>
		<div class="assign-row">
			<div class="form-field form-field--grow">
				<label class="form-label" for="mem-i">Custom Instructions</label>
				<textarea id="mem-i" name="mem-i" autocomplete="off" class="form-input form-textarea" bind:value={caps.memory.instructions} rows="4" placeholder="Optional instructions that guide how the assistant stores and recalls memories"></textarea>
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

<style>
	.cap-tab { display: flex; flex-direction: column; gap: var(--space-4); }
	.sub-tabs { display: flex; align-items: center; gap: var(--space-2); padding-bottom: var(--space-1); }
	.loading-hint { display: inline-flex; align-items: center; gap: var(--space-2); margin-left: auto; font-size: var(--text-xs); color: var(--color-text-tertiary); }
	.sub-panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: var(--space-5); }
	.section-desc { font-size: var(--text-xs); color: var(--color-text-tertiary); margin-bottom: var(--space-3); }
	.form-field { display: flex; flex-direction: column; gap: var(--space-1); flex: 1; min-width: 140px; }
	.form-field--grow { flex: 2; min-width: 180px; }
	.form-field--narrow { flex: 0 0 100px; min-width: 80px; }
	.form-hint { font-size: var(--text-xs); color: var(--color-text-tertiary); }
	.assign-section { margin-bottom: var(--space-4); }
	.assign-heading { font-size: var(--text-xs); font-weight: var(--font-semibold); text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text); margin-bottom: var(--space-2); }
	.assign-required { color: var(--color-danger); font-weight: normal; text-transform: none; letter-spacing: normal; }
	.assign-optional { color: var(--color-text-tertiary); font-weight: normal; text-transform: none; letter-spacing: normal; }
	.assign-row { display: flex; align-items: flex-end; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-2); }
	.form-textarea { height: auto; padding: var(--space-2) var(--space-3); resize: vertical; }
	.save-footer { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--color-border); display: flex; justify-content: flex-end; align-items: center; gap: var(--space-3); }
	.save-footer-left { display: flex; align-items: center; gap: var(--space-3); margin-right: auto; }
	.feedback { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); font-size: var(--text-sm); border-radius: var(--radius-md); margin-bottom: var(--space-4); }
	.feedback span { flex: 1; }
	.feedback--success { background: var(--color-success-bg); color: var(--color-text); }
	.feedback--error { background: var(--color-danger-bg); color: var(--color-text); }
	.btn-dismiss { background: none; border: none; color: inherit; cursor: pointer; opacity: 0.6; font-size: var(--text-sm); }
	.btn-dismiss:hover { opacity: 1; }
	.error-state { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-4) var(--space-5); font-size: var(--text-sm); color: var(--color-danger); }
	.empty-state { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-8); color: var(--color-text-tertiary); text-align: center; }
</style>
