<script lang="ts">
	import { getAdminToken } from '$lib/auth.js';
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
	import ConnectProviderSheet from './opencode/ConnectProviderSheet.svelte';

	interface Props { loading: boolean; onRefresh: () => void; }
	let { loading, onRefresh }: Props = $props();

	let pageLoading = $state(true);
	let loadError = $state('');
	let saving = $state(false);
	let saveError = $state('');
	let saveSuccess = $state(false);
	let secrets = $state<Record<string, string>>({});
	let detectedLocal = $state<Array<{ provider: string; url: string; available: boolean }>>([]);
	let providerModels = $state<Record<string, string[]>>({});

	type CloudConnection = { provider: string; hasKey: boolean; keyPreview: string };
	let cloudConnections = $state<CloudConnection[]>([]);

	// Add connection form — open flag + fields + status grouped into two objects
	let addConn = $state<{ open: boolean; provider: string; apiKey: string }>({ open: false, provider: '', apiKey: '' });
	let addStatus = $state<{ testing: boolean; tested: boolean; error: string }>({ testing: false, tested: false, error: '' });

	// OpenCode sheet
	let openCodeSheetOpen = $state(false);

	// All capability fields in one reactive object
	let cap = $state({
		llmProvider: '', llmModel: '', llmApiKey: '',
		slmProvider: '', slmModel: '',
		embProvider: '', embModel: '', embDims: 768, embApiKey: '',
		memUserId: 'default_user', memInstructions: '',
		ttsEnabled: false, ttsProvider: '', ttsModel: '', ttsVoice: '',
		sttEnabled: false, sttProvider: '', sttModel: '', sttLanguage: '',
		rerankEnabled: false, rerankProvider: '', rerankMode: 'llm' as 'llm' | 'dedicated', rerankModel: '', rerankTopK: 10,
	});

	// Derived
	let connectedProviders = $derived.by(() => {
		const result: Array<{ id: string; name: string }> = [];
		for (const d of detectedLocal) {
			if (d.available) {
				const def = PROVIDERS.find((p) => p.id === d.provider);
				if (def) result.push({ id: def.id, name: def.name });
			}
		}
		for (const c of cloudConnections) {
			if (!result.some((r) => r.id === c.provider)) {
				const def = PROVIDERS.find((p) => p.id === c.provider);
				if (def) result.push({ id: def.id, name: def.name });
			}
		}
		return result;
	});

	let llmNeedsKey = $derived(PROVIDERS.find((p) => p.id === cap.llmProvider)?.needsKey ?? false);
	let llmHasKey = $derived(PROVIDER_KEY_MAP[cap.llmProvider] ? !!secrets[PROVIDER_KEY_MAP[cap.llmProvider]] : false);
	let llmModels = $derived(providerModels[cap.llmProvider] ?? []);
	let embModels = $derived(providerModels[cap.embProvider] ?? []);
	let embNeedsKey = $derived((PROVIDERS.find((p) => p.id === cap.embProvider)?.needsKey ?? false) && cap.embProvider !== cap.llmProvider);
	let embHasKey = $derived(PROVIDER_KEY_MAP[cap.embProvider] ? !!secrets[PROVIDER_KEY_MAP[cap.embProvider]] : false);

	const groups = [
		{ id: 'recommended', label: 'Recommended' },
		{ id: 'local', label: 'Local' },
		{ id: 'cloud', label: 'Cloud' },
		{ id: 'advanced', label: 'Advanced' },
	] as const;

	// Load
	async function loadAll(): Promise<void> {
		const token = getAdminToken();
		if (!token) return;
		pageLoading = true;
		loadError = '';
		try {
			const [dto, assign] = await Promise.all([fetchCapabilitiesDto(token), fetchAssignments(token)]);
			secrets = dto.secrets ?? {};

			const built: CloudConnection[] = [];
			for (const provDef of PROVIDERS.filter((p) => p.needsKey)) {
				const envKey = PROVIDER_KEY_MAP[provDef.id];
				if (envKey && secrets[envKey]) {
					built.push({ provider: provDef.id, hasKey: true, keyPreview: (secrets[envKey] as string).slice(0, 6) + '••••' });
				}
			}
			cloudConnections = built;

			const loaded = assign.capabilities as Record<string, unknown> | null;
			if (loaded) {
				const llmStr = (loaded.llm as string) ?? '';
				const s = llmStr.indexOf('/');
				if (s > 0) { cap.llmProvider = llmStr.slice(0, s); cap.llmModel = llmStr.slice(s + 1); }
				const slmStr = (loaded.slm as string) ?? '';
				const s2 = slmStr.indexOf('/');
				if (s2 > 0) { cap.slmProvider = slmStr.slice(0, s2); cap.slmModel = slmStr.slice(s2 + 1); }
				const emb = loaded.embeddings as Record<string, unknown> | undefined;
				cap.embProvider = (emb?.provider as string) ?? '';
				cap.embModel = (emb?.model as string) ?? '';
				cap.embDims = (emb?.dims as number) ?? 768;
				const mem = loaded.memory as Record<string, unknown> | undefined;
				cap.memUserId = (mem?.userId as string) ?? 'default_user';
				cap.memInstructions = (mem?.customInstructions as string) ?? '';
				const tts = loaded.tts as Record<string, unknown> | undefined;
				cap.ttsEnabled = (tts?.enabled as boolean) ?? false;
				cap.ttsProvider = (tts?.provider as string) ?? '';
				cap.ttsModel = (tts?.model as string) ?? '';
				cap.ttsVoice = (tts?.voice as string) ?? '';
				const stt = loaded.stt as Record<string, unknown> | undefined;
				cap.sttEnabled = (stt?.enabled as boolean) ?? false;
				cap.sttProvider = (stt?.provider as string) ?? '';
				cap.sttModel = (stt?.model as string) ?? '';
				cap.sttLanguage = (stt?.language as string) ?? '';
				const rr = loaded.reranking as Record<string, unknown> | undefined;
				cap.rerankEnabled = (rr?.enabled as boolean) ?? false;
				cap.rerankProvider = (rr?.provider as string) ?? '';
				cap.rerankMode = (rr?.mode as 'llm' | 'dedicated') ?? 'llm';
				cap.rerankModel = (rr?.model as string) ?? '';
				cap.rerankTopK = (rr?.topK as number) ?? 10;
			}
			try { const om = await fetchMemoryConfig(token); if (om?.config?.memory?.custom_instructions) cap.memInstructions = om.config.memory.custom_instructions; } catch {}
			try { const r = await detectLocalProviders(token); detectedLocal = r.providers ?? []; } catch {}
			if (cap.llmProvider) void probeModels(cap.llmProvider);
			if (cap.embProvider && cap.embProvider !== cap.llmProvider) void probeModels(cap.embProvider);
		} catch (e) { loadError = e instanceof Error ? e.message : 'Failed to load.'; }
		finally { pageLoading = false; }
	}
	$effect(() => { void loadAll(); });

	async function probeModels(id: string): Promise<void> {
		if (providerModels[id]?.length) return;
		const token = getAdminToken(); if (!token) return;
		const def = PROVIDERS.find((p) => p.id === id); if (!def) return;
		const det = detectedLocal.find((d) => d.provider === id && d.available);
		const baseUrl = det?.url || def.baseUrl; if (!baseUrl) return;
		const envKey = PROVIDER_KEY_MAP[id];
		const apiKey = envKey ? (secrets[envKey] ?? '') : '';
		try {
			const kind = def.kind === 'local' ? 'openai_compatible_local' : 'openai_compatible_remote';
			const r = await testCapability(token, { baseUrl, apiKey, kind, provider: id });
			if (r.ok && r.models?.length) providerModels = { ...providerModels, [id]: r.models };
		} catch {}
	}

	// Look up embedding dims, stripping any Ollama-style tag (e.g. "nomic-embed-text:latest" → "nomic-embed-text")
	function lookupEmbDims(model: string): number {
		if (KNOWN_EMB_DIMS[model]) return KNOWN_EMB_DIMS[model];
		const bare = model.includes(':') ? model.slice(0, model.lastIndexOf(':')) : model;
		return KNOWN_EMB_DIMS[bare] ?? 0;
	}

	// Generic provider change handler — updates provider + default model, probes models
	function handleProviderChange(providerKey: keyof typeof cap, modelKey: keyof typeof cap, modelField: 'llmModel' | 'embModel' | null) {
		return (newVal: string) => {
			(cap as Record<string, unknown>)[providerKey] = newVal;
			const def = PROVIDERS.find((p) => p.id === newVal);
			if (modelField === 'embModel') {
				(cap as Record<string, unknown>)[modelKey] = def?.embModel ?? '';
				if (def?.embDims) cap.embDims = def.embDims;
				else { const d = lookupEmbDims(def?.embModel ?? ''); if (d) cap.embDims = d; }
			} else {
				(cap as Record<string, unknown>)[modelKey] = def?.llmModel ?? '';
			}
			void probeModels(newVal);
		};
	}

	// Add connection
	async function handleTestAdd(): Promise<void> {
		if (!addConn.provider) return;
		const token = getAdminToken(); if (!token) return;
		const def = PROVIDERS.find((p) => p.id === addConn.provider); if (!def) return;
		addStatus = { testing: true, tested: false, error: '' };
		try {
			const r = await testCapability(token, { baseUrl: def.baseUrl, apiKey: addConn.apiKey, kind: 'openai_compatible_remote', provider: addConn.provider });
			if (r.ok) { addStatus = { testing: false, tested: true, error: '' }; providerModels = { ...providerModels, [def.id]: r.models ?? [] }; }
			else addStatus = { testing: false, tested: false, error: (r as { error?: string }).error ?? 'Failed' };
		} catch (e) { addStatus = { testing: false, tested: false, error: e instanceof Error ? e.message : 'Failed' }; }
	}

	async function handleSaveAdd(): Promise<void> {
		if (!addConn.provider) return;
		const token = getAdminToken(); if (!token) return;
		try {
			await saveCapabilities(token, { provider: addConn.provider, apiKey: addConn.apiKey });
			cloudConnections = [...cloudConnections.filter((c) => c.provider !== addConn.provider),
				{ provider: addConn.provider, hasKey: true, keyPreview: addConn.apiKey.slice(0, 6) + '••••' }];
			addConn = { open: false, provider: '', apiKey: '' };
			addStatus = { testing: false, tested: false, error: '' };
		} catch (e) { addStatus = { ...addStatus, error: e instanceof Error ? e.message : 'Save failed.' }; }
	}

	// Save capabilities
	async function handleSave(): Promise<void> {
		const token = getAdminToken(); if (!token) return;
		saving = true; saveError = ''; saveSuccess = false;
		try {
			if (cap.llmApiKey) await saveCapabilities(token, { provider: cap.llmProvider, apiKey: cap.llmApiKey });
			if (cap.embApiKey && cap.embProvider !== cap.llmProvider) await saveCapabilities(token, { provider: cap.embProvider, apiKey: cap.embApiKey });
			const p: Record<string, unknown> = {
				llm: cap.llmProvider && cap.llmModel ? `${cap.llmProvider}/${cap.llmModel}` : undefined,
				embeddings: cap.embProvider && cap.embModel ? { provider: cap.embProvider, model: cap.embModel, dims: cap.embDims } : undefined,
				memory: { userId: cap.memUserId, customInstructions: cap.memInstructions },
			};
			if (cap.slmProvider && cap.slmModel) p.slm = `${cap.slmProvider}/${cap.slmModel}`; else p.slm = undefined;
			p.tts = cap.ttsEnabled ? { enabled: true, provider: cap.ttsProvider || undefined, model: cap.ttsModel || undefined, voice: cap.ttsVoice || undefined } : undefined;
			p.stt = cap.sttEnabled ? { enabled: true, provider: cap.sttProvider || undefined, model: cap.sttModel || undefined, language: cap.sttLanguage || undefined } : undefined;
			p.reranking = cap.rerankEnabled ? { enabled: true, provider: cap.rerankProvider || undefined, mode: cap.rerankMode, model: cap.rerankModel || undefined, topK: cap.rerankTopK } : undefined;
			await saveAssignments(token, p);
			cap.llmApiKey = ''; cap.embApiKey = ''; saveSuccess = true; setTimeout(() => saveSuccess = false, 4000); onRefresh();
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

{#snippet provSelect(id: string, value: string, onchange: (v: string) => void)}
<select {id} onchange={(e) => onchange((e.currentTarget as HTMLSelectElement).value)}>
	<option value="" selected={!value}>Select provider...</option>
	{#each connectedProviders as p}<option value={p.id} selected={p.id === value}>{p.name}</option>{/each}
</select>
{/snippet}

{#snippet modSelect(id: string, value: string, models: string[], placeholder: string, onchange: (v: string) => void)}
{#if models.length > 0}
	<select {id} onchange={(e) => onchange((e.currentTarget as HTMLSelectElement).value)}>
		{#if !value || !models.includes(value)}<option value={value || ''} selected>{value || 'Select...'}</option>{/if}
		{#each models as m}<option value={m} selected={m === value}>{m}</option>{/each}
	</select>
{:else}
	<input {id} type="text" {value} {placeholder} oninput={(e) => onchange((e.currentTarget as HTMLInputElement).value)} />
{/if}
{/snippet}

<div class="tab" role="tabpanel">
{#if pageLoading}
	<div class="panel"><p class="msg"><span class="spinner"></span> Loading...</p></div>
{:else if loadError}
	<div class="panel"><p class="msg err">{loadError} <button class="link" onclick={() => void loadAll()}>Retry</button></p></div>
{:else}

<!-- Connections -->
<div class="panel">
	<div class="hdr">
		<h2>Connections</h2>
		<div class="actions">
			<button class="btn ghost sm" onclick={() => openCodeSheetOpen = true}>OpenCode Providers</button>
			<button class="btn outline sm" onclick={() => { addConn = { open: !addConn.open, provider: '', apiKey: '' }; addStatus = { testing: false, tested: false, error: '' }; }}>
				{addConn.open ? 'Cancel' : '+ Add Connection'}
			</button>
		</div>
	</div>
	<div class="rows">
		{#each detectedLocal.filter(d => d.available) as d}
			{@const def = PROVIDERS.find(p => p.id === d.provider)}
			<div class="row"><span class="dot on"></span><b>{def?.name ?? d.provider}</b><span class="meta">{d.url}</span><span class="tag">local</span>
				{#if (providerModels[d.provider] ?? []).length > 0}<span class="meta">{(providerModels[d.provider] ?? []).length} models</span>{/if}
			</div>
		{/each}
		{#each cloudConnections as c}
			{@const def = PROVIDERS.find(p => p.id === c.provider)}
			<div class="row"><span class="dot on"></span><b>{def?.name ?? c.provider}</b><span class="meta">{c.keyPreview}</span><span class="tag cloud">cloud</span>
				<button class="xbtn" aria-label="Remove" onclick={() => { cloudConnections = cloudConnections.filter(x => x.provider !== c.provider); }}>x</button>
			</div>
		{/each}
		{#if !detectedLocal.some(d => d.available) && cloudConnections.length === 0 && !addConn.open}
			<div class="row empty">No providers connected.</div>
		{/if}
	</div>
	{#if addConn.open}
		<div class="add-form">
			<select bind:value={addConn.provider}>
				<option value="">Provider...</option>
				{#each groups as g}<optgroup label={g.label}>{#each PROVIDERS.filter(p => p.group === g.id && (p.needsKey || p.optionalKey)) as p}<option value={p.id}>{p.name}</option>{/each}</optgroup>{/each}
			</select>
			{#if addConn.provider}
				<input type="password" bind:value={addConn.apiKey} placeholder={PROVIDERS.find(p => p.id === addConn.provider)?.placeholder ?? 'API key'} autocomplete="off" />
				<button class="btn outline sm" disabled={addStatus.testing || !addConn.provider} onclick={() => void handleTestAdd()}>
					{#if addStatus.testing}<span class="spinner"></span>{:else}Test{/if}
				</button>
				{#if addStatus.tested}<button class="btn primary sm" onclick={() => void handleSaveAdd()}>Save</button>{/if}
			{/if}
			{#if addStatus.error}<span class="err-text">{addStatus.error}</span>{/if}
		</div>
	{/if}
</div>

<!-- Capabilities -->
<div class="panel">
	<div class="hdr"><h2>Capabilities</h2></div>
	{#if saveSuccess}<div class="banner ok">Saved.</div>{/if}
	{#if saveError}<div class="banner err">{saveError}</div>{/if}

	<div class="form">
		<section>
			<h3>Language Model</h3>
			<div class="fields">
				<div class="f md"><label for="llm-p">Provider</label>{@render provSelect('llm-p', cap.llmProvider, handleProviderChange('llmProvider', 'llmModel', 'llmModel'))}</div>
				<div class="f grow"><label for="llm-m">Model</label>{@render modSelect('llm-m', cap.llmModel, llmModels, 'model', v => cap.llmModel = v)}</div>
			</div>
			{#if llmNeedsKey}
				<div class="fields"><div class="f grow">
					<label for="llm-k">API Key</label>
					<input id="llm-k" type="password" bind:value={cap.llmApiKey} placeholder={PROVIDERS.find(p => p.id === cap.llmProvider)?.placeholder ?? 'key'} autocomplete="off" />
					{#if llmHasKey}<span class="hint">Key set. Leave empty to keep.</span>{/if}
				</div></div>
			{/if}
		</section>

		<section>
			<h3>Small Language Model <span class="opt">optional</span></h3>
			<div class="fields">
				<div class="f md"><label for="slm-p">Provider</label>{@render provSelect('slm-p', cap.slmProvider, handleProviderChange('slmProvider', 'slmModel', null))}</div>
				<div class="f grow"><label for="slm-m">Model</label>{@render modSelect('slm-m', cap.slmModel, providerModels[cap.slmProvider] ?? [], 'model', v => cap.slmModel = v)}</div>
			</div>
		</section>

		<section>
			<h3>Embeddings</h3>
			<div class="fields">
				<div class="f md"><label for="emb-p">Provider</label>{@render provSelect('emb-p', cap.embProvider, handleProviderChange('embProvider', 'embModel', 'embModel'))}</div>
				<div class="f md"><label for="emb-m">Model</label>{@render modSelect('emb-m', cap.embModel, embModels, 'nomic-embed-text', v => { cap.embModel = v; const d = lookupEmbDims(v); if (d) cap.embDims = d; })}</div>
				<div class="f xs"><label for="emb-d">Dims</label><input id="emb-d" type="number" bind:value={cap.embDims} min="1" max="8192" /></div>
			</div>
			{#if embNeedsKey}
				<div class="fields"><div class="f grow">
					<label for="emb-k">API Key</label>
					<input id="emb-k" type="password" bind:value={cap.embApiKey} placeholder="key" autocomplete="off" />
					{#if embHasKey}<span class="hint">Key set. Leave empty to keep.</span>{/if}
				</div></div>
			{/if}
		</section>

		<section>
			<h3>Memory</h3>
			<div class="fields">
				<div class="f sm"><label for="mem-u">User ID</label><input id="mem-u" type="text" bind:value={cap.memUserId} /></div>
			</div>
			<div class="fields">
				<div class="f grow"><label for="mem-i">Custom Instructions</label><textarea id="mem-i" bind:value={cap.memInstructions} rows="2" placeholder="Optional"></textarea></div>
			</div>
			<div class="reset-row">
				<button class="btn danger sm" onclick={() => void handleResetMemory()}>Reset Memory Collection</button>
			</div>
		</section>

		<hr />

		<section class="ext">
			<div class="ext-row">
				<div><b>Text-to-Speech</b><br><span class="meta">Audio from responses</span></div>
				<label class="model-toggle"><input type="checkbox" bind:checked={cap.ttsEnabled} /><span class="model-toggle-track"></span></label>
			</div>
			{#if cap.ttsEnabled}
				<div class="fields">
					<div class="f md"><label for="tts-p">Provider</label>{@render provSelect('tts-p', cap.ttsProvider, v => cap.ttsProvider = v)}</div>
					<div class="f md"><label for="tts-m">Model</label><input id="tts-m" type="text" bind:value={cap.ttsModel} placeholder="tts-1" /></div>
					<div class="f md"><label for="tts-v">Voice</label><input id="tts-v" type="text" bind:value={cap.ttsVoice} placeholder="alloy" /></div>
				</div>
			{/if}
		</section>

		<section class="ext">
			<div class="ext-row">
				<div><b>Speech-to-Text</b><br><span class="meta">Transcribe audio</span></div>
				<label class="model-toggle"><input type="checkbox" bind:checked={cap.sttEnabled} /><span class="model-toggle-track"></span></label>
			</div>
			{#if cap.sttEnabled}
				<div class="fields">
					<div class="f md"><label for="stt-p">Provider</label>{@render provSelect('stt-p', cap.sttProvider, v => cap.sttProvider = v)}</div>
					<div class="f md"><label for="stt-m">Model</label><input id="stt-m" type="text" bind:value={cap.sttModel} placeholder="whisper-1" /></div>
					<div class="f md"><label for="stt-l">Language</label><input id="stt-l" type="text" bind:value={cap.sttLanguage} placeholder="en" /></div>
				</div>
			{/if}
		</section>

		<section class="ext">
			<div class="ext-row">
				<div><b>Reranking</b><br><span class="meta">Re-rank search results</span></div>
				<label class="model-toggle"><input type="checkbox" bind:checked={cap.rerankEnabled} /><span class="model-toggle-track"></span></label>
			</div>
			{#if cap.rerankEnabled}
				<div class="fields">
					<div class="f md"><label for="rr-p">Provider</label>{@render provSelect('rr-p', cap.rerankProvider, v => cap.rerankProvider = v)}</div>
					<div class="f xs"><label for="rr-mode">Mode</label><select id="rr-mode" bind:value={cap.rerankMode}><option value="llm">LLM</option><option value="dedicated">Dedicated</option></select></div>
					<div class="f md"><label for="rr-m">Model</label><input id="rr-m" type="text" bind:value={cap.rerankModel} /></div>
					<div class="f xs"><label for="rr-k">Top K</label><input id="rr-k" type="number" bind:value={cap.rerankTopK} min="1" max="100" /></div>
				</div>
			{/if}
		</section>
	</div>

	<div class="footer">
		<button class="btn primary" onclick={() => void handleSave()} disabled={saving || !cap.llmProvider || !cap.llmModel}>
			{#if saving}<span class="spinner"></span>{/if} Save Changes
		</button>
	</div>
</div>

{/if}
</div>

{#if openCodeSheetOpen}<ConnectProviderSheet open={openCodeSheetOpen} onClose={() => openCodeSheetOpen = false} onConnected={() => void loadAll()} />{/if}

<style>
	.tab { display: flex; flex-direction: column; gap: var(--space-4); }
	.panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; }
	.hdr { display: flex; align-items: center; justify-content: space-between; padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-border); }
	.hdr h2 { font-size: var(--text-sm); font-weight: var(--font-semibold); }
	.actions { display: flex; gap: var(--space-2); }
	.msg { padding: var(--space-4); color: var(--color-text-secondary); font-size: var(--text-sm); display: flex; align-items: center; gap: var(--space-2); }
	.msg.err { color: var(--color-danger); }
	.link { background: none; border: none; color: var(--color-primary); cursor: pointer; text-decoration: underline; }

	/* Connections */
	.rows { padding: 0; }
	.row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--color-bg-tertiary); font-size: var(--text-sm); }
	.row:last-child { border-bottom: none; }
	.row.empty { color: var(--color-text-tertiary); justify-content: center; padding: var(--space-4); }
	.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.dot.on { background: var(--color-success); }
	.tag { font-size: 10px; font-weight: var(--font-semibold); padding: 1px 6px; border-radius: var(--radius-full); text-transform: uppercase; background: var(--color-bg-tertiary); color: var(--color-text-tertiary); }
	.tag.cloud { background: var(--color-info-bg); color: var(--color-info); }
	.meta { font-size: var(--text-xs); color: var(--color-text-tertiary); }
	.xbtn { background: none; border: none; color: var(--color-text-tertiary); cursor: pointer; margin-left: auto; font-size: var(--text-sm); }
	.xbtn:hover { color: var(--color-danger); }

	/* Add form */
	.add-form { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--color-border); background: var(--color-bg-secondary); flex-wrap: wrap; }
	.add-form select, .add-form input { height: 32px; padding: 0 var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg); color: var(--color-text); font-size: var(--text-sm); font-family: inherit; }
	.add-form select { min-width: 140px; }
	.add-form input { flex: 1; min-width: 160px; }
	.err-text { font-size: var(--text-xs); color: var(--color-danger); }

	/* Form */
	.form { padding: var(--space-4); }
	section { margin-bottom: var(--space-4); }
	section:last-child { margin-bottom: 0; }
	h3 { font-size: var(--text-xs); font-weight: var(--font-semibold); text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text); margin-bottom: var(--space-2); padding-bottom: var(--space-1); border-bottom: 1px solid var(--color-bg-tertiary); }
	.opt { font-weight: normal; color: var(--color-text-tertiary); text-transform: none; letter-spacing: normal; }
	.fields { display: flex; gap: var(--space-3); margin-bottom: var(--space-2); flex-wrap: wrap; }
	.f { display: flex; flex-direction: column; gap: 2px; }
	.f.xs { flex: 0 0 80px; }
	.f.sm { flex: 0 0 180px; }
	.f.md { flex: 1; min-width: 140px; max-width: 240px; }
	.f.grow { flex: 2; min-width: 180px; }
	.f label { font-size: var(--text-xs); color: var(--color-text-secondary); }
	.f select, .f input, .f textarea { height: 32px; padding: 0 var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg); color: var(--color-text); font-size: var(--text-sm); font-family: inherit; }
	.f textarea { height: auto; padding: var(--space-2); resize: vertical; }
	.f select:focus, .f input:focus, .f textarea:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 2px var(--color-primary-subtle); }
	.hint { font-size: var(--text-xs); color: var(--color-text-tertiary); }

	.reset-row { margin-top: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--color-bg-tertiary); }
	hr { border: none; border-top: 1px solid var(--color-border); margin: var(--space-4) 0; }

	/* Extensions */
	.ext { border: 1px solid var(--color-bg-tertiary); border-radius: var(--radius-md); padding: var(--space-3); margin-bottom: var(--space-2); }
	.ext:last-child { margin-bottom: 0; }
	.ext-row { display: flex; align-items: center; justify-content: space-between; }
	.ext-row b { font-size: var(--text-sm); }
	.ext .fields { margin-top: var(--space-3); }

	/* Banners */
	.banner { padding: var(--space-2) var(--space-4); font-size: var(--text-sm); }
	.banner.ok { background: var(--color-success-bg); color: var(--color-success); }
	.banner.err { background: var(--color-danger-bg); color: var(--color-danger); }

	/* Footer */
	.footer { padding: var(--space-3) var(--space-4); border-top: 1px solid var(--color-border); background: var(--color-bg-secondary); display: flex; justify-content: flex-end; }

	/* Buttons */
	.btn { display: inline-flex; align-items: center; gap: var(--space-1); padding: 6px 14px; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: var(--font-semibold); border: 1px solid transparent; border-radius: var(--radius-md); cursor: pointer; white-space: nowrap; }
	.btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn.primary { background: var(--color-primary); color: #000; }
	.btn.primary:hover:not(:disabled) { background: var(--color-primary-hover); }
	.btn.outline { background: none; color: var(--color-primary); border-color: var(--color-primary); }
	.btn.outline:hover:not(:disabled) { background: var(--color-primary-subtle); }
	.btn.ghost { background: none; border: none; color: var(--color-text-secondary); }
	.btn.ghost:hover { color: var(--color-text); }
	.btn.danger { background: var(--color-danger); color: #fff; }
	.btn.sm { padding: 4px 10px; font-size: var(--text-xs); }
	.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	@media (max-width: 640px) { .fields { flex-direction: column; } .f.xs, .f.sm, .f.md, .f.grow { max-width: none; } }
</style>
