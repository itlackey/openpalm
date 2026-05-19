<script lang="ts">
	import { onMount } from 'svelte';
	import type { OpenCodeProviderSummary, OpenCodeAuthMethod } from '$lib/types.js';
	import {
		buildHeaders,
		fetchAssignments,
		saveAssignments,
	} from '$lib/api.js';
	import { lookupEmbeddingDims } from '@openpalm/lib/provider-constants';
	import type { VoiceEngineValue } from '$lib/wizard/types.js';
	import VoiceEngineSelector from './voice/VoiceEngineSelector.svelte';

	type ProviderEntry = OpenCodeProviderSummary & { authMethods: OpenCodeAuthMethod[] };

	// ── Sub-tab state ───────────────────────────────────────────────
	let activeSubTab = $state<'akm' | 'tts-stt'>('akm');

	// ── Page state ──────────────────────────────────────────────────
	let pageLoading = $state(false);
	let loadError = $state('');

	// ── Provider state (for capability dropdowns) ───────────────────
	let ocProviders = $state<ProviderEntry[]>([]);
	let providerModels = $state<Record<string, string[]>>({});

	// ── Capability fields ───────────────────────────────────────────
	// tts / stt hold the full engine + settings shape used by the
	// VoiceEngineSelector. Empty `engine` or `skip-*` means disabled.
	let caps = $state({
		llm: { provider: '', model: '' },
		slm: { provider: '', model: '' },
		embeddings: { provider: '', model: '', dims: 768 },
		tts: { engine: '' } as VoiceEngineValue,
		stt: { engine: '' } as VoiceEngineValue,
		reranking: { provider: '', mode: 'llm' as 'llm' | 'dedicated', model: '', topK: 10 },
		akm: {
			feedback_distillation: true,
			memory_inference: true,
			memory_consolidation: true,
		},
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
		for (const id of [caps.llm.provider, caps.slm.provider, caps.embeddings.provider, caps.reranking.provider]) {
			if (id && !ids.has(id)) { result.push({ id, name: id }); ids.add(id); }
		}
		return result;
	});

	// ── Load data ───────────────────────────────────────────────────
	async function loadProviderDropdowns(): Promise<void> {
		try {
			const res = await fetch('/admin/opencode/providers', { headers: buildHeaders() });
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

	function readVoiceValue(raw: unknown): VoiceEngineValue {
		if (typeof raw === 'string') return { engine: raw };
		if (raw && typeof raw === 'object') {
			const obj = raw as Record<string, unknown>;
			// When the legacy shape { provider: "openai" } is loaded, we use
			// provider as the engine fallback. In that case do NOT also copy
			// it to v.provider — it would write both fields on the next save.
			const hasEngine = typeof obj.engine === 'string';
			const v: VoiceEngineValue = {
				engine: hasEngine ? (obj.engine as string)
					: typeof obj.provider === 'string' ? obj.provider
					: '',
			};
			// Only populate provider when a distinct engine field is present.
			if (hasEngine && typeof obj.provider === 'string') v.provider = obj.provider;
			if (typeof obj.model === 'string') v.model = obj.model;
			if (typeof obj.voice === 'string') v.voice = obj.voice;
			if (typeof obj.language === 'string') v.language = obj.language;
			return v;
		}
		return { engine: '' };
	}

	async function loadCapabilities(): Promise<void> {
		try {
			const res = await fetchAssignments();
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
			// tts / stt: full engine + settings object (legacy strings also handled)
			caps.tts = readVoiceValue(loaded.tts);
			caps.stt = readVoiceValue(loaded.stt);
			const rr = loaded.reranking as Record<string, unknown> | undefined;
			caps.reranking.provider = (rr?.provider as string) ?? '';
			caps.reranking.mode = (rr?.mode as 'llm' | 'dedicated') ?? 'llm';
			caps.reranking.model = (rr?.model as string) ?? '';
			caps.reranking.topK = (rr?.topK as number) ?? 10;
			const akm = loaded.akm as Record<string, unknown> | undefined;
			caps.akm.feedback_distillation = (akm?.feedback_distillation as boolean) ?? true;
			caps.akm.memory_inference = (akm?.memory_inference as boolean) ?? true;
			caps.akm.memory_consolidation = (akm?.memory_consolidation as boolean) ?? true;
		} catch {
			// will show empty state
		}
	}

	async function loadAll(): Promise<void> {
		pageLoading = true;
		loadError = '';
		try {
			await loadProviderDropdowns();
			await loadCapabilities();
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Failed to load.';
		} finally {
			pageLoading = false;
		}
	}
	onMount(() => { void loadAll(); });

	function lookupEmbDims(model: string): number {
		return lookupEmbeddingDims(caps.embeddings.provider, model);
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
		saving = true; saveError = ''; saveSuccess = false;
		try {
			const { llm, slm, embeddings: emb, tts, stt, reranking: rr, akm } = caps;
			const voicePayload = (v: VoiceEngineValue): Record<string, unknown> | undefined => {
				if (!v.engine || v.engine.startsWith('skip-')) return undefined;
				const out: Record<string, unknown> = { enabled: true, engine: v.engine };
				if (v.provider) out.provider = v.provider;
				if (v.model) out.model = v.model;
				if (v.voice) out.voice = v.voice;
				if (v.language) out.language = v.language;
				return out;
			};
			const p: Record<string, unknown> = {
				llm: llm.provider && llm.model ? `${llm.provider}/${llm.model}` : undefined,
				slm: slm.provider && slm.model ? `${slm.provider}/${slm.model}` : undefined,
				embeddings: emb.provider && emb.model ? { provider: emb.provider, model: emb.model, dims: emb.dims } : undefined,
				tts: voicePayload(tts),
				stt: voicePayload(stt),
				reranking: rr.provider ? { enabled: true, provider: rr.provider, mode: rr.mode, model: rr.model || undefined, topK: rr.topK } : undefined,
				akm: {
					feedback_distillation: akm.feedback_distillation,
					memory_inference: akm.memory_inference,
					memory_consolidation: akm.memory_consolidation,
				},
			};
			await saveAssignments(p);
			saveSuccess = true; setTimeout(() => saveSuccess = false, 4000);
		} catch (e) { saveError = e instanceof Error ? e.message : 'Save failed.'; }
		finally { saving = false; }
	}

</script>

<div class="cap-tab" role="tabpanel">

{#if loadError}
	<div class="error-state">{loadError} <button class="btn btn-secondary btn-sm" onclick={() => void loadAll()}>Retry</button></div>
{/if}

<!-- Sub-tab pills -->
<div class="sub-tabs" role="tablist">
	<button class="pill" class:pill--active={activeSubTab === 'akm'} role="tab" aria-selected={activeSubTab === 'akm'} onclick={() => { activeSubTab = 'akm'; saveSuccess = false; saveError = ''; }}>akm</button>
	<button class="pill" class:pill--active={activeSubTab === 'tts-stt'} role="tab" aria-selected={activeSubTab === 'tts-stt'} onclick={() => { activeSubTab = 'tts-stt'; saveSuccess = false; saveError = ''; }}>TTS/STT</button>
	{#if pageLoading}<span class="loading-hint"><span class="spinner"></span> Loading...</span>{/if}
</div>

<!-- ═══════════════════════════════════════════════════════════════ -->
<!-- akm SUB-TAB                                                   -->
<!-- ═══════════════════════════════════════════════════════════════ -->
{#if activeSubTab === 'akm'}
<div class="sub-panel">

	{#if connectedProviders.length === 0}
		<div class="empty-state">
			<p>No providers connected. Use the <strong>Connections</strong> tab to authenticate with an OpenCode provider. Models picked here drive akm operations (knowledge indexing, memory consolidation, feedback distillation).</p>
		</div>
	{:else}

	{#if saveSuccess}<div class="feedback feedback--success"><span>Saved.</span></div>{/if}
	{#if saveError}<div class="feedback feedback--error"><span>{saveError}</span>
		<button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => saveError = ''}>x</button>
	</div>{/if}

	<!-- LLM -->
	<div class="assign-section">
		<h3 class="assign-heading">Reasoning Model <span class="assign-required">required</span></h3>
		<p class="section-desc">Model akm uses when no small model is configured. Also drives the assistant container's default chat model. OpenCode-specific provider settings live in the Connections tab.</p>
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
		<h3 class="assign-heading">Small Model <span class="assign-optional">optional</span></h3>
		<p class="section-desc">Lightweight model for akm's stash improvement, memory consolidation, and feedback distillation. Keeps the primary model free for live assistant conversations.</p>
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
		<p class="section-desc">Embedding model for semantic search. akm uses this to index stash assets and recall relevant context during assistant sessions.</p>
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
		<p class="section-desc">Re-rank akm semantic search results for better relevance. Leave empty to disable.</p>
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

	<!-- akm Features -->
	<div class="assign-section">
		<h3 class="assign-heading">Features</h3>
		<p class="section-desc">akm runtime features. Disable a toggle if you want akm to skip that operation across all sessions.</p>
		<label class="toggle-row">
			<input type="checkbox" bind:checked={caps.akm.feedback_distillation} />
			<div>
				<span class="toggle-title">Feedback distillation</span>
				<span class="toggle-desc">Distill durable lessons from user feedback during stash-improve runs.</span>
			</div>
		</label>
		<label class="toggle-row">
			<input type="checkbox" bind:checked={caps.akm.memory_inference} />
			<div>
				<span class="toggle-title">Memory inference</span>
				<span class="toggle-desc">Infer new memories from assistant sessions.</span>
			</div>
		</label>
		<label class="toggle-row">
			<input type="checkbox" bind:checked={caps.akm.memory_consolidation} />
			<div>
				<span class="toggle-title">Memory consolidation</span>
				<span class="toggle-desc">Merge / dedupe overlapping memories on the consolidation pass.</span>
			</div>
		</label>
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
<!-- TTS/STT SUB-TAB                                               -->
<!-- ═══════════════════════════════════════════════════════════════ -->
{:else if activeSubTab === 'tts-stt'}
<div class="sub-panel">

	{#if saveSuccess}<div class="feedback feedback--success"><span>Saved.</span></div>{/if}
	{#if saveError}<div class="feedback feedback--error"><span>{saveError}</span>
		<button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => saveError = ''}>x</button>
	</div>{/if}

	<p class="section-desc">Pick an engine for the assistant's voice. These defaults seed the voice channel's web app on first load. Once a user saves their own settings in that app, browser preferences take precedence.</p>

	<div class="engine-section">
		<h3 class="engine-heading">Text-to-Speech</h3>
		<p class="engine-subheading">How your assistant speaks</p>
		<VoiceEngineSelector kind="tts" value={caps.tts} onchange={(v) => caps.tts = v} />
	</div>

	<div class="engine-section">
		<h3 class="engine-heading">Speech-to-Text</h3>
		<p class="engine-subheading">How your assistant hears you</p>
		<VoiceEngineSelector kind="stt" value={caps.stt} onchange={(v) => caps.stt = v} />
	</div>

	<div class="save-footer">
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
	.assign-section { margin-bottom: var(--space-4); }
	.assign-heading { font-size: var(--text-xs); font-weight: var(--font-semibold); text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text); margin-bottom: var(--space-2); }
	.assign-required { color: var(--color-danger); font-weight: normal; text-transform: none; letter-spacing: normal; }
	.assign-optional { color: var(--color-text-tertiary); font-weight: normal; text-transform: none; letter-spacing: normal; }
	.assign-row { display: flex; align-items: flex-end; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-2); }
	.save-footer { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--color-border); display: flex; justify-content: flex-end; align-items: center; gap: var(--space-3); }
	.feedback { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); font-size: var(--text-sm); border-radius: var(--radius-md); margin-bottom: var(--space-4); }
	.feedback span { flex: 1; }
	.feedback--success { background: var(--color-success-bg); color: var(--color-text); }
	.feedback--error { background: var(--color-danger-bg); color: var(--color-text); }
	.error-state { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-4) var(--space-5); font-size: var(--text-sm); color: var(--color-danger); }
	.toggle-row { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-2) 0; cursor: pointer; }
	.toggle-row input[type="checkbox"] { width: 16px; height: 16px; margin-top: 3px; flex-shrink: 0; }
	.toggle-row > div { display: flex; flex-direction: column; }
	.toggle-title { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); }
	.toggle-desc { font-size: var(--text-xs); color: var(--color-text-tertiary); margin-top: 2px; }

	.engine-section { margin-bottom: var(--space-5); }
	.engine-heading { font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text); margin-bottom: var(--space-1); }
	.engine-subheading { font-size: var(--text-xs); color: var(--color-text-tertiary); margin-bottom: var(--space-3); }
</style>
