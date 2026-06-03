<script lang="ts">
	import { onMount } from 'svelte';
	import {
		fetchAkmConfig,
		saveAkmConfig,
		fetchHostAkmSharing,
		enableHostAkmSharing,
		disableHostAkmSharing,
		type HostAkmSharing,
	} from '$lib/api.js';
	import { notifications } from '$lib/notifications.svelte.js';

	interface Props { tokenStored: boolean; }
	let { tokenStored }: Props = $props();

	// ── Status ───────────────────────────────────────────────────────────────────
	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');

	// ── Host AKM sharing ───────────────────────────────────────────────────────
	let hostSharing = $state<HostAkmSharing | null>(null);
	let hostBusy = $state(false);
	let hostImportProfiles = $state(true);

	async function loadHostSharing(): Promise<void> {
		try {
			hostSharing = await fetchHostAkmSharing();
		} catch {
			hostSharing = null; // endpoint unavailable (e.g. not yet deployed) — hide the panel
		}
	}

	async function toggleHostSharing(): Promise<void> {
		if (hostBusy) return;
		hostBusy = true;
		try {
			if (hostSharing?.sharing.enabled) {
				hostSharing = await disableHostAkmSharing();
				notifications.push('success', 'Host AKM sharing disabled. Restart the stack to apply.');
			} else {
				const res = await enableHostAkmSharing({ writable: true, importProfiles: hostImportProfiles });
				hostSharing = res;
				const imported = res.profilesImported?.length
					? ` Imported: ${res.profilesImported.join(', ')}.`
					: '';
				notifications.push('success', `Host AKM sharing enabled.${imported} Restart the stack to mount /host-stash.`);
				if (hostImportProfiles) await load(); // reflect any imported profiles
			}
		} catch (e) {
			notifications.push('error', e instanceof Error ? e.message : 'Failed to update host AKM sharing.');
		} finally {
			hostBusy = false;
		}
	}

	async function reimportHostProfiles(): Promise<void> {
		if (hostBusy) return;
		hostBusy = true;
		try {
			const res = await enableHostAkmSharing({ writable: true, importProfiles: true });
			hostSharing = res;
			const imported = res.profilesImported?.length ? res.profilesImported.join(', ') : 'none';
			notifications.push('success', `Re-imported host profiles: ${imported}.`);
			await load();
		} catch (e) {
			notifications.push('error', e instanceof Error ? e.message : 'Failed to re-import host profiles.');
		} finally {
			hostBusy = false;
		}
	}

	// ── Profile types ────────────────────────────────────────────────────────────
	interface LlmProfile {
		id: string;
		name: string;
		endpoint: string;
		model: string;
		provider: string;
		apiKey: string;
		showApiKey: boolean;
		temperature: string;
		maxTokens: string;
		timeoutMs: string;
		concurrency: string;
		contextLength: string;
		judgeModel: string;
		supportsJsonSchema: boolean;
	}

	interface AgentProfile {
		id: string;
		name: string;
		platform: 'opencode' | 'claude' | 'opencode-sdk';
		bin: string;
		args: string;
		workspace: string;
		model: string;
	}

	type FMode = '' | 'llm' | 'agent' | 'sdk';
	interface FEntry { enabled: boolean; mode: FMode; profile: string; timeoutMs: string; }

	interface ImproveProfile {
		id: string;
		name: string;
		description: string;
		limit: number;
		autoAccept: number;
		processes: {
			reflect: FEntry;
			distill: FEntry;
			consolidate: FEntry;
			validation: FEntry;
			memoryInference: FEntry;
			graphExtraction: FEntry;
			extract: FEntry;
		};
	}

	// ── LLM Profiles ─────────────────────────────────────────────────────────────
	let llmProfiles = $state<LlmProfile[]>([]);
	let defaultLlmProfile = $state('');

	// ── Agent Profiles ────────────────────────────────────────────────────────────
	let agentProfiles = $state<AgentProfile[]>([]);
	let defaultAgentProfile = $state('');

	// ── Improve Profiles ──────────────────────────────────────────────────────────
	let improveProfiles = $state<ImproveProfile[]>([]);
	let defaultImproveProfile = $state('');

	// ── Embedding Connection ──────────────────────────────────────────────────────
	let embEndpoint = $state('');
	let embModel = $state('');
	let embProvider = $state('');
	let embApiKey = $state('');
	let showEmbApiKey = $state(false);
	let embDimension = $state(1536);
	let embLocalModel = $state('');
	let embBatchSize = $state('');
	let embChunkSize = $state('');
	let embContextLength = $state('');
	let embOllamaNumCtx = $state('');

	// ── Behavior ─────────────────────────────────────────────────────────────────
	let semanticSearchMode = $state<'auto' | 'off'>('auto');
	let stashDir = $state('');
	let outputFormat = $state<'json' | 'yaml' | 'text'>('json');
	let outputDetail = $state<'brief' | 'normal' | 'full'>('brief');

	// ── Drawer ────────────────────────────────────────────────────────────────────
	type DrawerType = 'llm' | 'agent' | 'improve' | null;
	let drawerType = $state<DrawerType>(null);
	let drawerLlm = $state<LlmProfile | null>(null);
	let drawerAgent = $state<AgentProfile | null>(null);
	let drawerImprove = $state<ImproveProfile | null>(null);

	// ── Derived ──────────────────────────────────────────────────────────────────
	let llmProfileNames = $derived(llmProfiles.map(p => p.name).filter(n => n));

	// ── Helpers ──────────────────────────────────────────────────────────────────
	function optNum(s: string | number): number | undefined {
		if (typeof s === 'number') return isNaN(s) ? undefined : s;
		const n = parseFloat(s);
		return s.trim() === '' || isNaN(n) ? undefined : n;
	}
	function optInt(s: string | number): number | undefined {
		if (typeof s === 'number') return isNaN(s) ? undefined : Math.trunc(s);
		const n = parseInt(s, 10);
		return s.trim() === '' || isNaN(n) ? undefined : n;
	}

	function newLlmProfile(): LlmProfile {
		return { id: crypto.randomUUID(), name: '', endpoint: '', model: '', provider: '', apiKey: '', showApiKey: false, temperature: '', maxTokens: '', timeoutMs: '', concurrency: '', contextLength: '', judgeModel: '', supportsJsonSchema: false };
	}
	function newAgentProfile(): AgentProfile {
		return { id: crypto.randomUUID(), name: '', platform: 'opencode', bin: '', args: '', workspace: '', model: '' };
	}
	function newImproveProfile(): ImproveProfile {
		return {
			id: crypto.randomUUID(), name: '', description: '', limit: 25, autoAccept: 0,
			processes: {
				reflect: { enabled: true, mode: '', profile: '', timeoutMs: '' },
				distill: { enabled: true, mode: '', profile: '', timeoutMs: '' },
				consolidate: { enabled: false, mode: '', profile: '', timeoutMs: '' },
				validation: { enabled: false, mode: '', profile: '', timeoutMs: '' },
				memoryInference: { enabled: true, mode: '', profile: '', timeoutMs: '' },
				graphExtraction: { enabled: true, mode: '', profile: '', timeoutMs: '' },
				extract: { enabled: true, mode: '', profile: '', timeoutMs: '' },
			},
		};
	}

	function readFEntry(raw: unknown, defaultEnabled: boolean): FEntry {
		if (typeof raw === 'boolean') return { enabled: raw, mode: '', profile: '', timeoutMs: '' };
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { enabled: defaultEnabled, mode: '', profile: '', timeoutMs: '' };
		const r = raw as Record<string, unknown>;
		return {
			enabled: typeof r.enabled === 'boolean' ? r.enabled : defaultEnabled,
			mode: (r.mode as FMode) ?? '',
			profile: (r.profile as string) ?? '',
			timeoutMs: r.timeoutMs != null ? String(r.timeoutMs) : '',
		};
	}

	function buildProcessConfig(e: FEntry): Record<string, unknown> {
		const out: Record<string, unknown> = { enabled: e.enabled };
		if (e.mode) out.mode = e.mode;
		if (e.profile) out.profile = e.profile;
		if (e.timeoutMs !== '') out.timeoutMs = parseInt(e.timeoutMs, 10);
		return out;
	}

	function profileFromRaw(raw: Record<string, unknown>): Omit<LlmProfile, 'name' | 'id'> {
		return {
			endpoint: (raw.endpoint as string) ?? '',
			model: (raw.model as string) ?? '',
			provider: (raw.provider as string) ?? '',
			apiKey: (raw.apiKey as string) ?? '',
			showApiKey: false,
			temperature: raw.temperature != null ? String(raw.temperature) : '',
			maxTokens: raw.maxTokens != null ? String(raw.maxTokens) : '',
			timeoutMs: raw.timeoutMs != null ? String(raw.timeoutMs) : '',
			concurrency: raw.concurrency != null ? String(raw.concurrency) : '',
			contextLength: raw.contextLength != null ? String(raw.contextLength) : '',
			judgeModel: (raw.judgeModel as string) ?? '',
			supportsJsonSchema: (raw.supportsJsonSchema as boolean) ?? false,
		};
	}

	function buildLlmProfilePayload(p: LlmProfile): Record<string, unknown> {
		const out: Record<string, unknown> = { endpoint: p.endpoint, model: p.model };
		if (p.provider) out.provider = p.provider;
		if (p.apiKey) out.apiKey = p.apiKey;
		const t = optNum(p.temperature); if (t !== undefined) out.temperature = t;
		const mt = optInt(p.maxTokens); if (mt !== undefined) out.maxTokens = mt;
		const to = optInt(p.timeoutMs); if (to !== undefined) out.timeoutMs = to;
		const co = optInt(p.concurrency); if (co !== undefined) out.concurrency = co;
		const cl = optInt(p.contextLength); if (cl !== undefined) out.contextLength = cl;
		if (p.judgeModel) out.judgeModel = p.judgeModel;
		if (p.supportsJsonSchema) out.supportsJsonSchema = true;
		return out;
	}

	function improveProfileFromRaw(name: string, raw: Record<string, unknown>): ImproveProfile {
		const procs = raw.processes as Record<string, unknown> | undefined;
		return {
			id: crypto.randomUUID(), name,
			description: (raw.description as string) ?? '',
			limit: typeof raw.limit === 'number' ? raw.limit : 25,
			autoAccept: typeof raw.autoAccept === 'number' ? raw.autoAccept : 0,
			processes: {
				reflect: readFEntry(procs?.reflect, true),
				distill: readFEntry(procs?.distill, true),
				consolidate: readFEntry(procs?.consolidate, false),
				validation: readFEntry(procs?.validation, false),
				memoryInference: readFEntry(procs?.memoryInference, true),
				graphExtraction: readFEntry(procs?.graphExtraction, true),
				extract: readFEntry(procs?.extract, true),
			},
		};
	}

	// ── Drawer actions ────────────────────────────────────────────────────────────
	function openLlmDrawer(p: LlmProfile) {
		drawerLlm = { ...p };
		drawerType = 'llm';
	}
	function openAgentDrawer(p: AgentProfile) {
		drawerAgent = { ...p };
		drawerType = 'agent';
	}
	function openImproveDrawer(ip: ImproveProfile) {
		drawerImprove = {
			...ip,
			processes: {
				reflect: { ...ip.processes.reflect },
				distill: { ...ip.processes.distill },
				consolidate: { ...ip.processes.consolidate },
				validation: { ...ip.processes.validation },
				memoryInference: { ...ip.processes.memoryInference },
				graphExtraction: { ...ip.processes.graphExtraction },
				extract: { ...ip.processes.extract },
			},
		};
		drawerType = 'improve';
	}

	function applyDrawer() {
		if (drawerType === 'llm' && drawerLlm) {
			const copy = { ...drawerLlm };
			const idx = llmProfiles.findIndex(p => p.id === copy.id);
			const oldName = idx >= 0 ? llmProfiles[idx].name : '';
			llmProfiles = idx >= 0
				? llmProfiles.map((p, i) => i === idx ? copy : p)
				: [...llmProfiles, copy];
			if (defaultLlmProfile === oldName) defaultLlmProfile = copy.name;
		} else if (drawerType === 'agent' && drawerAgent) {
			const copy = { ...drawerAgent };
			const idx = agentProfiles.findIndex(p => p.id === copy.id);
			const oldName = idx >= 0 ? agentProfiles[idx].name : '';
			agentProfiles = idx >= 0
				? agentProfiles.map((p, i) => i === idx ? copy : p)
				: [...agentProfiles, copy];
			if (defaultAgentProfile === oldName) defaultAgentProfile = copy.name;
		} else if (drawerType === 'improve' && drawerImprove) {
			const copy = { ...drawerImprove, processes: { ...drawerImprove.processes } };
			const idx = improveProfiles.findIndex(ip => ip.id === copy.id);
			const oldName = idx >= 0 ? improveProfiles[idx].name : '';
			improveProfiles = idx >= 0
				? improveProfiles.map((ip, i) => i === idx ? copy : ip)
				: [...improveProfiles, copy];
			if (defaultImproveProfile === oldName) defaultImproveProfile = copy.name;
		}
		closeDrawer();
	}

	function closeDrawer() {
		drawerType = null;
		drawerLlm = null;
		drawerAgent = null;
		drawerImprove = null;
	}

	function removeProfile(type: 'llm' | 'agent' | 'improve', id: string) {
		if (type === 'llm') {
			const name = llmProfiles.find(p => p.id === id)?.name ?? '';
			if (defaultLlmProfile === name) defaultLlmProfile = '';
			llmProfiles = llmProfiles.filter(p => p.id !== id);
		} else if (type === 'agent') {
			const name = agentProfiles.find(p => p.id === id)?.name ?? '';
			if (defaultAgentProfile === name) defaultAgentProfile = '';
			agentProfiles = agentProfiles.filter(p => p.id !== id);
		} else {
			const name = improveProfiles.find(ip => ip.id === id)?.name ?? '';
			if (defaultImproveProfile === name) defaultImproveProfile = '';
			improveProfiles = improveProfiles.filter(ip => ip.id !== id);
		}
		if (drawerType === type) closeDrawer();
	}

	// ── Load ─────────────────────────────────────────────────────────────────────
	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const { config } = await fetchAkmConfig();
			const rawProfiles = config.profiles as Record<string, unknown> | undefined;

			const rawLlm = rawProfiles?.llm as Record<string, unknown> | undefined;
			llmProfiles = rawLlm
				? Object.entries(rawLlm).map(([name, p]) => ({ id: crypto.randomUUID(), name, ...profileFromRaw(p as Record<string, unknown>) }))
				: [];

			const rawAgent = rawProfiles?.agent as Record<string, unknown> | undefined;
			agentProfiles = rawAgent
				? Object.entries(rawAgent).map(([name, p]) => {
					const raw = p as Record<string, unknown>;
					return { id: crypto.randomUUID(), name, platform: (raw.platform as 'opencode' | 'claude' | 'opencode-sdk') ?? 'opencode', bin: (raw.bin as string) ?? '', args: Array.isArray(raw.args) ? (raw.args as string[]).join(' ') : '', workspace: (raw.workspace as string) ?? '', model: (raw.model as string) ?? '' };
				})
				: [];

			const rawImpProfiles = rawProfiles?.improve as Record<string, unknown> | undefined;
			improveProfiles = rawImpProfiles
				? Object.entries(rawImpProfiles).map(([name, p]) => improveProfileFromRaw(name, p as Record<string, unknown>))
				: [];

			const rawDefaults = config.defaults as Record<string, unknown> | undefined;
			defaultLlmProfile = (rawDefaults?.llm as string) ?? '';
			defaultAgentProfile = (rawDefaults?.agent as string) ?? '';
			defaultImproveProfile = (rawDefaults?.improve as string) ?? '';

			const emb = config.embedding as Record<string, unknown> | undefined;
			embEndpoint = (emb?.endpoint as string) ?? '';
			embModel = (emb?.model as string) ?? '';
			embProvider = (emb?.provider as string) ?? '';
			embApiKey = (emb?.apiKey as string) ?? '';
			embDimension = typeof emb?.dimension === 'number' ? emb.dimension : 1536;
			embLocalModel = (emb?.localModel as string) ?? '';
			embBatchSize = emb?.batchSize != null ? String(emb.batchSize) : '';
			embChunkSize = emb?.chunkSize != null ? String(emb.chunkSize) : '';
			embContextLength = emb?.contextLength != null ? String(emb.contextLength) : '';
			const ollamaOpts = emb?.ollamaOptions as Record<string, unknown> | undefined;
			embOllamaNumCtx = ollamaOpts?.num_ctx != null ? String(ollamaOpts.num_ctx) : '';

			semanticSearchMode = (config.semanticSearchMode as 'auto' | 'off') ?? 'auto';
			stashDir = (config.stashDir as string) ?? '';
			const output = config.output as Record<string, unknown> | undefined;
			outputFormat = (output?.format as 'json' | 'yaml' | 'text') ?? 'json';
			outputDetail = (output?.detail as 'brief' | 'normal' | 'full') ?? 'brief';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load AKM config.';
		} finally {
			loading = false;
		}
	}

	// ── Save ─────────────────────────────────────────────────────────────────────
	async function save(): Promise<void> {
		saving = true;
		error = '';
		try {
			const profilesLlm: Record<string, unknown> = {};
			for (const p of llmProfiles) {
				if (p.name.trim()) profilesLlm[p.name.trim()] = buildLlmProfilePayload(p);
			}

			const profilesAgent: Record<string, unknown> = {};
			for (const p of agentProfiles) {
				if (!p.name.trim()) continue;
				const entry: Record<string, unknown> = { platform: p.platform };
				if (p.bin) entry.bin = p.bin;
				if (p.args) entry.args = p.args.split(/\s+/).filter(Boolean);
				if (p.workspace) entry.workspace = p.workspace;
				if (p.model) entry.model = p.model;
				profilesAgent[p.name.trim()] = entry;
			}

			const profilesImprove: Record<string, unknown> = {};
			for (const ip of improveProfiles) {
				if (!ip.name.trim()) continue;
				const entry: Record<string, unknown> = {
					limit: ip.limit,
					processes: {
						reflect: buildProcessConfig(ip.processes.reflect),
						distill: buildProcessConfig(ip.processes.distill),
						consolidate: buildProcessConfig(ip.processes.consolidate),
						validation: buildProcessConfig(ip.processes.validation),
						memoryInference: buildProcessConfig(ip.processes.memoryInference),
						graphExtraction: buildProcessConfig(ip.processes.graphExtraction),
						extract: buildProcessConfig(ip.processes.extract),
					},
				};
				if (ip.description) entry.description = ip.description;
				if (ip.autoAccept > 0) entry.autoAccept = ip.autoAccept;
				profilesImprove[ip.name.trim()] = entry;
			}

			const embPayload: Record<string, unknown> = { endpoint: embEndpoint, model: embModel, dimension: embDimension };
			if (embProvider) embPayload.provider = embProvider;
			if (embApiKey) embPayload.apiKey = embApiKey;
			if (embLocalModel) embPayload.localModel = embLocalModel;
			const bs = optInt(embBatchSize); if (bs !== undefined) embPayload.batchSize = bs;
			const cs = optInt(embChunkSize); if (cs !== undefined) embPayload.chunkSize = cs;
			const ecl = optInt(embContextLength); if (ecl !== undefined) embPayload.contextLength = ecl;
			const numCtx = optInt(embOllamaNumCtx); if (numCtx !== undefined) embPayload.ollamaOptions = { num_ctx: numCtx };

			const defaultsPayload: Record<string, unknown> = {};
			if (defaultLlmProfile) defaultsPayload.llm = defaultLlmProfile;
			if (defaultAgentProfile) defaultsPayload.agent = defaultAgentProfile;
			if (defaultImproveProfile) defaultsPayload.improve = defaultImproveProfile;

			await saveAkmConfig({
				profiles: { llm: profilesLlm, agent: profilesAgent, improve: profilesImprove },
				defaults: defaultsPayload,
				embedding: embPayload,
				semanticSearchMode,
				stashDir: stashDir.trim(),
				output: { format: outputFormat, detail: outputDetail },
			});
			notifications.push('success', 'AKM config saved.');
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to save AKM config.';
			notifications.push('error', msg);
		} finally {
			saving = false;
		}
	}

	onMount(() => { if (tokenStored) { void load(); void loadHostSharing(); } });
</script>

<!-- Datalist referenced by drawer improve profile inputs -->
<datalist id="llm-profiles-list">
	{#each llmProfileNames as name}<option value={name}></option>{/each}
</datalist>

<div class="panel" role="tabpanel">
	<div class="panel-header">
		<h2>Knowledge</h2>
		<div class="panel-header-actions">
			<button class="btn btn-secondary btn-sm" onclick={() => void load()} disabled={loading || saving || !tokenStored}>
				{#if loading}<span class="spinner"></span>{/if}
				Refresh
			</button>
			<button class="btn btn-primary btn-sm" onclick={() => void save()} disabled={loading || saving || !tokenStored}>
				{#if saving}<span class="spinner"></span>{/if}
				Save
			</button>
		</div>
	</div>

	{#if error}<div class="error-banner"><span>{error}</span></div>{/if}

	<div class="panel-body">

		<!-- ── LLM Profiles ──────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">LLM Profiles</h3>
			<p class="section-note">Named connection configs your improve pipeline can reference. Add one per LLM service you want AKM to use.</p>

			{#if llmProfiles.length === 0}
				<p class="empty-note">No LLM profiles configured — add one below.</p>
			{:else}
				<div class="profile-list">
					{#each llmProfiles as p (p.id)}
						<div class="profile-row">
							<span class="profile-row-name">{p.name || '(unnamed)'}</span>
							{#if defaultLlmProfile === p.name && p.name}
								<span class="badge badge--default">Default</span>
							{/if}
							<div class="profile-row-actions">
								{#if p.name && defaultLlmProfile !== p.name}
									<button class="btn btn-sm" onclick={() => { defaultLlmProfile = p.name; }} disabled={loading || saving}>Set Default</button>
								{/if}
								<button class="btn btn-sm" onclick={() => openLlmDrawer(p)} disabled={loading || saving}>Edit</button>
								<button class="btn btn-sm btn-danger" onclick={() => removeProfile('llm', p.id)} disabled={loading || saving}>Remove</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<button class="btn btn-secondary btn-sm" onclick={() => { drawerLlm = newLlmProfile(); drawerType = 'llm'; }} disabled={loading || saving}>
				+ Add LLM Profile
			</button>
		</section>

		<!-- ── Agent Profiles ────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Agent Profiles</h3>
			<p class="section-note">Named runner configs for pipeline steps that spawn a subprocess (opencode or claude CLI).</p>

			{#if agentProfiles.length === 0}
				<p class="empty-note">No agent profiles defined.</p>
			{:else}
				<div class="profile-list">
					{#each agentProfiles as p (p.id)}
						<div class="profile-row">
							<span class="profile-row-name">{p.name || '(unnamed)'}</span>
							<span class="badge">{p.platform}</span>
							{#if defaultAgentProfile === p.name && p.name}
								<span class="badge badge--default">Default</span>
							{/if}
							<div class="profile-row-actions">
								{#if p.name && defaultAgentProfile !== p.name}
									<button class="btn btn-sm" onclick={() => { defaultAgentProfile = p.name; }} disabled={loading || saving}>Set Default</button>
								{/if}
								<button class="btn btn-sm" onclick={() => openAgentDrawer(p)} disabled={loading || saving}>Edit</button>
								<button class="btn btn-sm btn-danger" onclick={() => removeProfile('agent', p.id)} disabled={loading || saving}>Remove</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<button class="btn btn-secondary btn-sm" onclick={() => { drawerAgent = newAgentProfile(); drawerType = 'agent'; }} disabled={loading || saving}>
				+ Add Agent Profile
			</button>
		</section>

		<!-- ── Improve Profiles ───────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Improve Profiles</h3>
			<p class="section-note">Named configurations for <code>akm improve</code>. Each profile defines which processes run and which LLM/agent they use.</p>

			{#if improveProfiles.length === 0}
				<p class="empty-note">No improve profiles defined — add one below.</p>
			{:else}
				<div class="profile-list">
					{#each improveProfiles as ip (ip.id)}
						<div class="profile-row">
							<span class="profile-row-name">{ip.name || '(unnamed)'}</span>
							{#if ip.description}
								<span class="profile-row-desc">{ip.description}</span>
							{/if}
							{#if defaultImproveProfile === ip.name && ip.name}
								<span class="badge badge--default">Default</span>
							{/if}
							<div class="profile-row-actions">
								{#if ip.name && defaultImproveProfile !== ip.name}
									<button class="btn btn-sm" onclick={() => { defaultImproveProfile = ip.name; }} disabled={loading || saving}>Set Default</button>
								{/if}
								<button class="btn btn-sm" onclick={() => openImproveDrawer(ip)} disabled={loading || saving}>Edit</button>
								<button class="btn btn-sm btn-danger" onclick={() => removeProfile('improve', ip.id)} disabled={loading || saving}>Remove</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<button class="btn btn-secondary btn-sm" onclick={() => { drawerImprove = newImproveProfile(); drawerType = 'improve'; }} disabled={loading || saving}>
				+ Add Improve Profile
			</button>
		</section>

		<!-- ── Embedding Connection ──────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Embedding Connection</h3>
			<p class="section-note">Vector embedding provider for semantic search. Leave Endpoint and Model blank to use built-in local embeddings.</p>
			<div class="controls controls--grid">
				<div class="control-group control-group--wide">
					<label class="control-label" for="embEndpoint">Endpoint</label>
					<input id="embEndpoint" class="control-input" type="url" spellcheck="false" placeholder="https://api.openai.com/v1/embeddings" bind:value={embEndpoint} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embModel">Model</label>
					<input id="embModel" class="control-input" type="text" spellcheck="false" placeholder="text-embedding-3-small" bind:value={embModel} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embProvider">Provider (label)</label>
					<input id="embProvider" class="control-input" type="text" spellcheck="false" placeholder="openai" bind:value={embProvider} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embApiKey">API Key</label>
					<div class="input-with-toggle">
						<input id="embApiKey" class="control-input" type={showEmbApiKey ? 'text' : 'password'} spellcheck="false" placeholder={'${AKM_EMBED_API_KEY}'} bind:value={embApiKey} disabled={loading || saving} />
						<button type="button" class="btn-icon" onclick={() => { showEmbApiKey = !showEmbApiKey; }} aria-label={showEmbApiKey ? 'Hide API key' : 'Show API key'}>
							{showEmbApiKey ? 'Hide' : 'Show'}
						</button>
					</div>
				</div>
				<div class="control-group">
					<label class="control-label" for="embDimension">Dimensions</label>
					<input id="embDimension" class="control-input control-input--narrow" type="number" min="1" bind:value={embDimension} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embLocalModel">Local model</label>
					<input id="embLocalModel" class="control-input" type="text" spellcheck="false" placeholder="Xenova/bge-small-en-v1.5" bind:value={embLocalModel} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embBatchSize">Batch size</label>
					<input id="embBatchSize" class="control-input control-input--narrow" type="number" min="1" bind:value={embBatchSize} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embChunkSize">Chunk size (chars)</label>
					<input id="embChunkSize" class="control-input control-input--narrow" type="number" min="1" bind:value={embChunkSize} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embContextLength">Context length</label>
					<input id="embContextLength" class="control-input control-input--narrow" type="number" min="1" bind:value={embContextLength} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embOllamaNumCtx">Ollama num_ctx</label>
					<input id="embOllamaNumCtx" class="control-input control-input--narrow" type="number" min="1" bind:value={embOllamaNumCtx} disabled={loading || saving} />
				</div>
			</div>
		</section>

		<!-- ── Behavior ──────────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Behavior</h3>
			<div class="controls controls--grid">
				<div class="control-group">
					<label class="control-label" for="semanticSearch">Semantic search</label>
					<select id="semanticSearch" class="control-input" bind:value={semanticSearchMode} disabled={loading || saving}>
						<option value="auto">Auto (vector index when available)</option>
						<option value="off">Off (keyword only)</option>
					</select>
				</div>
				<div class="control-group">
					<label class="control-label" for="outputFormat">Output format</label>
					<select id="outputFormat" class="control-input" bind:value={outputFormat} disabled={loading || saving}>
						<option value="json">JSON</option>
						<option value="yaml">YAML</option>
						<option value="text">Text</option>
					</select>
				</div>
				<div class="control-group">
					<label class="control-label" for="outputDetail">Output detail</label>
					<select id="outputDetail" class="control-input" bind:value={outputDetail} disabled={loading || saving}>
						<option value="brief">Brief</option>
						<option value="normal">Normal</option>
						<option value="full">Full</option>
					</select>
				</div>
				<div class="control-group control-group--wide">
					<label class="control-label" for="stashDir">Stash directory</label>
					<input id="stashDir" class="control-input" type="text" spellcheck="false" placeholder="~/.akm (default)" bind:value={stashDir} disabled={loading || saving} />
				</div>
			</div>
		</section>


			<!-- ── Host AKM Sharing ──────────────────────────────────────────── -->
			{#if hostSharing}
				<section class="config-section">
					<h3 class="section-title">Host AKM Sharing</h3>
					<p class="section-note">
						Share knowledge with your personal AKM stash on this machine (<code>~/akm</code>).
						The assistant reads it and can contribute back; each side keeps its own primary
						stash, database, and cache — only the knowledge files are shared. Enabling adds a
						source entry to your <code>~/.config/akm/config.json</code> and mounts
						<code>~/akm</code> into the assistant. Your files' ownership and primary stash are
						never changed. Changes take effect after the next stack restart.
					</p>
					<div class="controls controls--grid">
						<div class="control-group control-group--wide">
							<span class="control-label">Status</span>
							<div class="host-akm-status">
								<span class="badge {hostSharing.sharing.enabled ? 'badge--on' : 'badge--off'}">
									{hostSharing.sharing.enabled ? 'Enabled' : 'Disabled'}
								</span>
								{#if hostSharing.hostStashPath}
									<code class="host-akm-path">{hostSharing.hostStashPath}</code>
								{/if}
							</div>
						</div>
						{#if !hostSharing.sharing.enabled}
							<div class="control-group control-group--wide">
								<label class="control-label control-label--checkbox">
									<input type="checkbox" bind:checked={hostImportProfiles} disabled={hostBusy} />
									Also import host LLM/agent profiles (read-only snapshot)
								</label>
							</div>
						{/if}
						<div class="control-group control-group--wide host-akm-actions">
							<button
								class="btn {hostSharing.sharing.enabled ? 'btn-secondary' : 'btn-primary'} btn-sm"
								onclick={() => void toggleHostSharing()}
								disabled={hostBusy || !tokenStored}>
								{#if hostBusy}<span class="spinner"></span>{/if}
								{hostSharing.sharing.enabled ? 'Disable host sharing' : 'Enable host sharing'}
							</button>
							{#if hostSharing.sharing.enabled}
								<button
									class="btn btn-secondary btn-sm"
									onclick={() => void reimportHostProfiles()}
									disabled={hostBusy || !tokenStored}>
									Re-import host profiles
								</button>
							{/if}
						</div>
					</div>
				</section>
			{/if}

	</div>

	<!-- ── Slide-in Drawer ───────────────────────────────────────────────────── -->
	{#if drawerType !== null}
		<div class="drawer-scrim" role="presentation" onclick={closeDrawer}></div>

		<div class="drawer" role="dialog" aria-modal="true" aria-label="Edit profile">
			<div class="drawer-header">
				<h3 class="drawer-title">
					{#if drawerType === 'llm'}LLM Profile
					{:else if drawerType === 'agent'}Agent Profile
					{:else}Improve Profile{/if}
				</h3>
				<button class="drawer-close" onclick={closeDrawer} aria-label="Close">✕</button>
			</div>

			<div class="drawer-body">

				{#if drawerType === 'llm' && drawerLlm}
					<div class="controls controls--grid">
						<div class="control-group">
							<label class="control-label" for="d-llm-name">Profile Name</label>
							<input id="d-llm-name" class="control-input" type="text" spellcheck="false" placeholder="e.g. default" bind:value={drawerLlm.name} />
						</div>
						<div class="control-group control-group--wide">
							<label class="control-label" for="d-llm-endpoint">Endpoint</label>
							<input id="d-llm-endpoint" class="control-input" type="url" spellcheck="false" placeholder="https://api.openai.com/v1/chat/completions" bind:value={drawerLlm.endpoint} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-model">Model</label>
							<input id="d-llm-model" class="control-input" type="text" spellcheck="false" placeholder="gpt-4o-mini" bind:value={drawerLlm.model} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-provider">Provider (label)</label>
							<input id="d-llm-provider" class="control-input" type="text" spellcheck="false" placeholder="openai" bind:value={drawerLlm.provider} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-apikey">API Key</label>
							<div class="input-with-toggle">
								<input id="d-llm-apikey" class="control-input" type={drawerLlm.showApiKey ? 'text' : 'password'} spellcheck="false" placeholder={'${AKM_LLM_API_KEY}'} bind:value={drawerLlm.apiKey} />
								<button type="button" class="btn-icon" onclick={() => { if (drawerLlm) drawerLlm.showApiKey = !drawerLlm.showApiKey; }} aria-label={drawerLlm.showApiKey ? 'Hide' : 'Show'}>
									{drawerLlm.showApiKey ? 'Hide' : 'Show'}
								</button>
							</div>
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-temperature">Temperature (0–2)</label>
							<input id="d-llm-temperature" class="control-input control-input--narrow" type="number" min="0" max="2" step="0.1" bind:value={drawerLlm.temperature} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-maxtokens">Max tokens</label>
							<input id="d-llm-maxtokens" class="control-input control-input--narrow" type="number" min="1" bind:value={drawerLlm.maxTokens} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-timeout">Timeout (ms)</label>
							<input id="d-llm-timeout" class="control-input control-input--narrow" type="number" min="1" bind:value={drawerLlm.timeoutMs} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-concurrency">Concurrency</label>
							<input id="d-llm-concurrency" class="control-input control-input--narrow" type="number" min="1" bind:value={drawerLlm.concurrency} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-contextlength">Context length</label>
							<input id="d-llm-contextlength" class="control-input control-input--narrow" type="number" min="1" bind:value={drawerLlm.contextLength} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-judgemodel">Judge model</label>
							<input id="d-llm-judgemodel" class="control-input" type="text" spellcheck="false" placeholder="gpt-4o" bind:value={drawerLlm.judgeModel} />
						</div>
					</div>
					<label class="toggle-row" style="margin-top: var(--space-4)">
						<input type="checkbox" bind:checked={drawerLlm.supportsJsonSchema} />
						<span class="toggle-label">Supports JSON schema</span>
						<span class="toggle-hint">Use response_format: json_schema for structured output</span>
					</label>

				{:else if drawerType === 'agent' && drawerAgent}
					<div class="controls controls--grid">
						<div class="control-group">
							<label class="control-label" for="d-agent-name">Profile Name</label>
							<input id="d-agent-name" class="control-input" type="text" spellcheck="false" placeholder="e.g. opencode" bind:value={drawerAgent.name} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-agent-platform">Platform</label>
							<select id="d-agent-platform" class="control-input" bind:value={drawerAgent.platform}>
								<option value="opencode">opencode</option>
								<option value="claude">claude</option>
								<option value="opencode-sdk">opencode-sdk</option>
							</select>
						</div>
						{#if drawerAgent.platform !== 'opencode-sdk'}
							<div class="control-group">
								<label class="control-label" for="d-agent-bin">Binary</label>
								<input id="d-agent-bin" class="control-input" type="text" spellcheck="false" placeholder="opencode" bind:value={drawerAgent.bin} />
							</div>
							<div class="control-group control-group--wide">
								<label class="control-label" for="d-agent-args">Extra args (space-separated)</label>
								<input id="d-agent-args" class="control-input" type="text" spellcheck="false" placeholder="run --model gpt-4o" bind:value={drawerAgent.args} />
							</div>
						{:else}
							<div class="control-group">
								<label class="control-label" for="d-agent-model">Model</label>
								<input id="d-agent-model" class="control-input" type="text" spellcheck="false" placeholder="anthropic/claude-sonnet-4-5" bind:value={drawerAgent.model} />
							</div>
							<div class="control-group">
								<label class="control-label" for="d-agent-workspace">Workspace</label>
								<input id="d-agent-workspace" class="control-input" type="text" spellcheck="false" placeholder={'${PWD}'} bind:value={drawerAgent.workspace} />
							</div>
						{/if}
					</div>

				{:else if drawerType === 'improve' && drawerImprove}
					<div class="controls controls--grid">
						<div class="control-group">
							<label class="control-label" for="d-imp-name">Profile Name</label>
							<input id="d-imp-name" class="control-input" type="text" spellcheck="false" placeholder="e.g. default" bind:value={drawerImprove.name} />
						</div>
						<div class="control-group control-group--wide">
							<label class="control-label" for="d-imp-desc">Description</label>
							<input id="d-imp-desc" class="control-input" type="text" spellcheck="false" placeholder="Optional description" bind:value={drawerImprove.description} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-imp-limit">Max proposals per run</label>
							<input id="d-imp-limit" class="control-input control-input--narrow" type="number" min="1" max="100" bind:value={drawerImprove.limit} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-imp-autoacc">Auto-accept threshold (0 = manual)</label>
							<input id="d-imp-autoacc" class="control-input control-input--narrow" type="number" min="0" max="1" step="0.05" bind:value={drawerImprove.autoAccept} />
						</div>
					</div>

					<div class="feature-table">
						<div class="feature-table-head">
							<span></span><span>Process</span><span>Mode</span><span>Profile</span><span>Timeout (ms)</span>
						</div>
						{#each [
							[drawerImprove.processes.reflect,        'reflect',        'Propose stash updates via self-reflection']        as [FEntry, string, string],
							[drawerImprove.processes.distill,        'distill',        'Quality-judge and distill feedback']               as [FEntry, string, string],
							[drawerImprove.processes.consolidate,    'consolidate',    'Deduplicate and merge overlapping memories']        as [FEntry, string, string],
							[drawerImprove.processes.validation,     'validation',     'Third-model confidence and staleness scoring']      as [FEntry, string, string],
							[drawerImprove.processes.memoryInference,'memoryInference','Derive structured memories from pending files']      as [FEntry, string, string],
							[drawerImprove.processes.graphExtraction,'graphExtraction','Extract entities and relations for graph search']   as [FEntry, string, string],
							[drawerImprove.processes.extract,        'extract',        'Read session logs and queue insight proposals']     as [FEntry, string, string],
						] as [proc, key, hint] (key)}
							<div class="feature-row">
								<input type="checkbox" bind:checked={proc.enabled} />
								<div><span class="feat-name">{key}</span><span class="feat-hint">{hint}</span></div>
								<select class="control-input" bind:value={proc.mode}>
									<option value="">Default</option>
									<option value="llm">LLM (direct call)</option>
									<option value="agent">Agent (subprocess)</option>
									<option value="sdk">SDK (programmatic)</option>
								</select>
								<input class="control-input" type="text" spellcheck="false" list="llm-profiles-list" placeholder="— default profile —" bind:value={proc.profile} />
								<input class="control-input control-input--narrow" type="number" min="1" placeholder="unlimited" bind:value={proc.timeoutMs} />
							</div>
						{/each}
					</div>
				{/if}

			</div>

			<div class="drawer-footer">
				<button class="btn btn-secondary" onclick={closeDrawer}>Cancel</button>
				<button class="btn btn-primary" onclick={applyDrawer}>Apply</button>
			</div>
		</div>
	{/if}

</div>

<style>
	.panel-header {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: var(--space-6);
		position: sticky; top: 0; z-index: 10;
		background: var(--color-bg);
		padding-top: var(--space-2);
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--color-border);
	}
	.panel-header h2 { font-size: var(--text-lg); font-weight: var(--font-semibold); color: var(--color-text); margin: 0; }
	.panel-header-actions { display: flex; gap: var(--space-2); }

	.panel-body { display: flex; flex-direction: column; gap: var(--space-8); }

	.config-section { display: flex; flex-direction: column; gap: var(--space-4); }

	.section-title {
		font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text);
		text-transform: uppercase; letter-spacing: 0.05em; margin: 0;
		padding-bottom: var(--space-2); border-bottom: 1px solid var(--color-border);
	}

	.section-note { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0; }
	.empty-note { font-size: var(--text-sm); color: var(--color-text-secondary); font-style: italic; margin: 0; }

	/* Profile list (compact rows) */
	.profile-list { display: flex; flex-direction: column; gap: var(--space-1); }
	.profile-row {
		display: flex; align-items: center; gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border); border-radius: var(--radius-sm);
		background: var(--color-bg-secondary);
	}
	.profile-row-name { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.profile-row-desc { font-size: var(--text-xs); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 20rem; }
	.profile-row-actions { display: flex; gap: var(--space-2); flex-shrink: 0; }

	/* Badges */
	.badge {
		font-size: var(--text-xs); padding: 2px var(--space-2); border-radius: var(--radius-sm);
		background: var(--color-bg-tertiary, var(--color-bg-secondary)); color: var(--color-text-secondary);
		border: 1px solid var(--color-border); white-space: nowrap; flex-shrink: 0;
	}
	.badge--default {
		background: var(--color-primary-subtle, rgba(99, 102, 241, 0.1));
		color: var(--color-primary, #6366f1);
		border-color: var(--color-primary-border, rgba(99, 102, 241, 0.3));
	}
	.badge--on {
		background: var(--color-success-subtle, rgba(34, 197, 94, 0.12));
		color: var(--color-success, #16a34a);
		border-color: var(--color-success-border, rgba(34, 197, 94, 0.3));
	}
	/* .badge--off intentionally uses the neutral base .badge styling. */

	/* Host AKM sharing */
	.host-akm-status { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
	.host-akm-path { font-size: var(--text-xs); color: var(--color-text-secondary); word-break: break-all; }
	.host-akm-actions { flex-direction: row; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
	.control-label--checkbox {
		display: flex; align-items: center; gap: var(--space-2);
		text-transform: none; letter-spacing: 0; font-weight: var(--font-normal, 400);
		font-size: var(--text-sm); color: var(--color-text-primary);
	}

	/* Controls */
	.controls { display: flex; flex-direction: column; gap: var(--space-4); }
	.controls--grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: var(--space-4); }
	.control-group { display: flex; flex-direction: column; gap: var(--space-1); }
	.control-group--wide { grid-column: 1 / -1; }
	.control-label { font-size: var(--text-xs); font-weight: var(--font-medium); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
	.control-input {
		font-size: var(--text-sm); color: var(--color-text);
		background: var(--color-input-bg, var(--color-bg)); border: 1px solid var(--color-border);
		border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); width: 100%;
	}
	.control-input--narrow { max-width: 8rem; }
	.control-input:focus { outline: 2px solid var(--color-primary); outline-offset: 1px; }
	.control-input:disabled { opacity: 0.5; cursor: not-allowed; }

	/* Password toggle */
	.input-with-toggle { display: flex; }
	.input-with-toggle .control-input { border-radius: var(--radius-sm) 0 0 var(--radius-sm); border-right: 0; flex: 1; min-width: 0; }
	.btn-icon {
		flex-shrink: 0; padding: var(--space-2) var(--space-3); font-size: var(--text-xs);
		font-weight: var(--font-medium); background: var(--color-bg-secondary);
		border: 1px solid var(--color-border); border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
		color: var(--color-text-secondary); cursor: pointer; white-space: nowrap;
	}
	.btn-icon:hover { background: var(--color-surface-hover); color: var(--color-text); }

	/* Toggle row */
	.toggle-row { display: flex; align-items: center; gap: var(--space-3); cursor: pointer; font-size: var(--text-sm); }
	.toggle-row input[type="checkbox"] { width: 1rem; height: 1rem; flex-shrink: 0; }
	.toggle-label { font-weight: var(--font-medium); color: var(--color-text); }
	.toggle-hint { color: var(--color-text-secondary); font-size: var(--text-xs); }

	/* Feature table (inside improve drawer) */
	.feature-table { display: flex; flex-direction: column; gap: var(--space-1); margin-top: var(--space-5); }
	.feature-table-head {
		display: grid; grid-template-columns: 1.5rem 1fr 9rem 11rem 7rem;
		gap: var(--space-2); padding: 0 var(--space-2) var(--space-1);
		font-size: var(--text-xs); font-weight: var(--font-semibold);
		color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em;
	}
	.feature-row {
		display: grid; grid-template-columns: 1.5rem 1fr 9rem 11rem 7rem;
		align-items: center; gap: var(--space-2); padding: var(--space-2);
		border: 1px solid var(--color-border); border-radius: var(--radius-sm);
		background: var(--color-bg-secondary);
	}
	.feature-row input[type="checkbox"] { width: 1rem; height: 1rem; }
	.feat-name { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); font-family: var(--font-mono); display: block; }
	.feat-hint { font-size: var(--text-xs); color: var(--color-text-secondary); }

	/* Slide-in drawer */
	.drawer-scrim {
		position: fixed; inset: 0;
		background: rgba(0, 0, 0, 0.35);
		z-index: 200;
	}
	.drawer {
		position: fixed; top: 0; right: 0; bottom: 0;
		width: min(640px, 92vw);
		background: var(--color-bg);
		border-left: 1px solid var(--color-border);
		box-shadow: -4px 0 32px rgba(0, 0, 0, 0.2);
		z-index: 201;
		display: flex; flex-direction: column;
		animation: drawer-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	@keyframes drawer-in {
		from { transform: translateX(100%); }
		to   { transform: translateX(0); }
	}
	.drawer-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-4) var(--space-6);
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
	}
	.drawer-title { font-size: var(--text-base); font-weight: var(--font-semibold); color: var(--color-text); margin: 0; }
	.drawer-close {
		width: 2rem; height: 2rem; border-radius: var(--radius-sm);
		background: transparent; border: 1px solid var(--color-border);
		color: var(--color-text-secondary); cursor: pointer; font-size: var(--text-sm);
		display: flex; align-items: center; justify-content: center;
	}
	.drawer-close:hover { background: var(--color-surface-hover); color: var(--color-text); }
	.drawer-body { flex: 1; overflow-y: auto; padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-5); }
	.drawer-footer {
		display: flex; justify-content: flex-end; gap: var(--space-3);
		padding: var(--space-4) var(--space-6);
		border-top: 1px solid var(--color-border);
		flex-shrink: 0;
	}

	/* Error banner */
	.error-banner {
		display: flex; align-items: center; gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		background: var(--color-error-bg, rgba(220, 38, 38, 0.08));
		border: 1px solid var(--color-error-border, rgba(220, 38, 38, 0.25));
		border-radius: var(--radius-md); font-size: var(--text-sm);
		color: var(--color-error, #dc2626); margin-bottom: var(--space-4);
	}
	.spinner { display: inline-block; width: 0.75rem; height: 0.75rem; border: 2px solid transparent; border-top-color: currentColor; border-radius: 50%; animation: spin 0.6s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
