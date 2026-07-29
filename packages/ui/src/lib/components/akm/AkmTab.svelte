<script lang="ts">
	import { onMount } from 'svelte';
 import {
		fetchAkmConfig,
		detectAkmEmbedding,
		reindexAkm,
		saveAkmConfig,
		testAkmEmbedding,
	} from '$lib/api.js';
	import { getRuntimeContext, hasCapability } from '$lib/runtime-context.svelte.js';
	import { notifications } from '$lib/notifications.svelte.js';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import AkmKnowledgeStatsSection from '$lib/components/akm/AkmKnowledgeStatsSection.svelte';
	import EmbeddingSection from '$lib/components/akm/EmbeddingSection.svelte';
	import BehaviorSection from '$lib/components/akm/BehaviorSection.svelte';
	import AkmHealthReportSection from '$lib/components/akm/AkmHealthReportSection.svelte';
	import LlmProfilesSection from '$lib/components/akm/LlmProfilesSection.svelte';
	import AgentProfilesSection from '$lib/components/akm/AgentProfilesSection.svelte';
	import ImproveProfilesSection from '$lib/components/akm/ImproveProfilesSection.svelte';
	import LlmProfileDrawer from '$lib/components/akm/LlmProfileDrawer.svelte';
	import AgentProfileDrawer from '$lib/components/akm/AgentProfileDrawer.svelte';
	import ImproveProfileDrawer from '$lib/components/akm/ImproveProfileDrawer.svelte';
	import {
		PROCESS_KEYS,
		DEFAULT_ENABLED,
		emptyFEntry,
		type Tri,
		type FEntry,
		type ProcKey,
	} from '$lib/components/akm/improve-process-helpers';
	import { akmConfigToForm, formToAkmPayload } from '$lib/components/akm/akm-config';
	import type { LlmProfile, AgentProfile, ImproveProfile } from '$lib/components/akm/profile-types';

	// ── Status ───────────────────────────────────────────────────────────────────
	let loading = $state(false);
	let saving = $state(false);
	let detectingEmbedding = $state(false);
	let testingEmbedding = $state(false);
	let reindexing = $state(false);
	let error = $state('');

	// Host AKM sharing now lives in its own Knowledge sub-tab
	// (akm/HostSharingSection.svelte) — moved out of this megaform.

	// Phase 4 AkmTab split: the config megaform is ASSISTANT-scoped
	// (/api/assistant/akm), while index maintenance + diagnostics run docker
	// commands on the HOST (/api/host/akm/*) — show them only with host
	// capabilities. hasCapability() is UX only; the endpoints enforce
	// capabilities server-side.
	//
	// Review 2026-07-10 K2: this used to be captured once as a plain `const`
	// at component init, so it never updated if `runtimeContext` resolved (or
	// changed) capabilities after this component was already mounted —
	// latent staleness. `$derived` re-reads `hasCapability()` whenever
	// `runtimeContext.effectiveCapabilities` changes.
	const runtimeContext = getRuntimeContext();
	const hostMaintenance = $derived(hasCapability(runtimeContext, 'host:containers'));

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
	let embDimension = $state(1536);
	let embLocalModel = $state('');
	let embBatchSize = $state('');
	let embChunkSize = $state('');
	let embContextLength = $state('');
	let embOllamaNumCtx = $state('');

	// ── Behavior ─────────────────────────────────────────────────────────────────
	let semanticSearchMode = $state<'auto' | 'off'>('auto');
	let outputFormat = $state<'json' | 'yaml' | 'text'>('json');
	let outputDetail = $state<'brief' | 'normal' | 'full'>('brief');

	// ── Advanced: top-level improve / search / feedback / index ────────────────────
	let imHalfLife = $state('');            // improve.utilityDecay.halfLifeDays
	let imFeedbackBoost = $state('');       // improve.utilityDecay.feedbackStabilityBoost
	let imEventRetention = $state('');      // improve.eventRetentionDays
	let searchMinScore = $state('');        // search.minScore
	let searchCurateRerank = $state<Tri>(''); // search.curateRerank.enabled
	let fbRequireReason = $state<Tri>('');   // feedback.requireReason
	let fbFailureModes = $state('');        // feedback.allowedFailureModes (comma-separated)
	let indexJson = $state('');             // index (raw JSON — complex per-pass schema)

	// ── Knowledge subtab ─────────────────────────────────────────────────────────
	// Two sections: AI Services (model/agent/improve connections + embedding) and
	// Behavior. Host Sharing moved to its own Knowledge sub-tab.
	let knowledgeSection = $state<'ai-services' | 'behavior' | 'health-report'>('ai-services');

	// ── Drawer ────────────────────────────────────────────────────────────────────
	type DrawerType = 'llm' | 'agent' | 'improve' | null;
	let drawerType = $state<DrawerType>(null);
	let drawerLlm = $state<LlmProfile | null>(null);
	let drawerAgent = $state<AgentProfile | null>(null);
	let drawerImprove = $state<ImproveProfile | null>(null);

	// ── Derived ──────────────────────────────────────────────────────────────────
	let llmProfileNames = $derived(llmProfiles.map(p => p.name).filter(n => n));

	// ── Helpers ──────────────────────────────────────────────────────────────────
	function newLlmProfile(): LlmProfile {
		return { id: crypto.randomUUID(), name: '', endpoint: '', model: '', provider: '', apiKey: '', showApiKey: false, temperature: '', maxTokens: '', timeoutMs: '', concurrency: '', contextLength: '', judgeModel: '', supportsJsonSchema: false, enableThinking: false, structuredOutput: false, extraParams: '' };
	}
	function newAgentProfile(): AgentProfile {
		return { id: crypto.randomUUID(), name: '', platform: 'opencode', bin: '', args: '', workspace: '', model: '' };
	}
	function newImproveProfile(): ImproveProfile {
		const processes = {} as Record<ProcKey, FEntry>;
		for (const k of PROCESS_KEYS) processes[k] = emptyFEntry(DEFAULT_ENABLED[k]);
		return {
			id: crypto.randomUUID(), name: '', description: '', limit: 25, autoAccept: 0,
			processes, syncEnabled: '', syncPush: '', syncMessage: '',
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
		const processes = {} as Record<ProcKey, FEntry>;
		for (const k of PROCESS_KEYS) {
			const src = ip.processes[k];
			processes[k] = { ...src, judgment: { ...src.judgment }, rest: { ...src.rest } };
		}
		drawerImprove = { ...ip, processes };
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
			const form = akmConfigToForm(config);

			llmProfiles = form.llmProfiles;
			agentProfiles = form.agentProfiles;
			improveProfiles = form.improveProfiles;
			defaultLlmProfile = form.defaultLlmProfile;
			defaultAgentProfile = form.defaultAgentProfile;
			defaultImproveProfile = form.defaultImproveProfile;

			embEndpoint = form.embedding.endpoint;
			embModel = form.embedding.model;
			embProvider = form.embedding.provider;
			embApiKey = form.embedding.apiKey;
			embDimension = form.embedding.dimension;
			embLocalModel = form.embedding.localModel;
			embBatchSize = form.embedding.batchSize;
			embChunkSize = form.embedding.chunkSize;
			embContextLength = form.embedding.contextLength;
			embOllamaNumCtx = form.embedding.ollamaNumCtx;

			semanticSearchMode = form.semanticSearchMode;
			outputFormat = form.outputFormat;
			outputDetail = form.outputDetail;

			imHalfLife = form.imHalfLife;
			imFeedbackBoost = form.imFeedbackBoost;
			imEventRetention = form.imEventRetention;
			searchMinScore = form.searchMinScore;
			searchCurateRerank = form.searchCurateRerank;
			fbRequireReason = form.fbRequireReason;
			fbFailureModes = form.fbFailureModes;
			indexJson = form.indexJson;
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
			const payload = formToAkmPayload({
				llmProfiles,
				defaultLlmProfile,
				agentProfiles,
				defaultAgentProfile,
				improveProfiles,
				defaultImproveProfile,
				embedding: {
					endpoint: embEndpoint,
					model: embModel,
					provider: embProvider,
					apiKey: embApiKey,
					dimension: embDimension,
					localModel: embLocalModel,
					batchSize: embBatchSize,
					chunkSize: embChunkSize,
					contextLength: embContextLength,
					ollamaNumCtx: embOllamaNumCtx,
				},
				semanticSearchMode,
				outputFormat,
				outputDetail,
				imHalfLife,
				imFeedbackBoost,
				imEventRetention,
				searchMinScore,
				searchCurateRerank,
				fbRequireReason,
				fbFailureModes,
				indexJson,
			});

			await saveAkmConfig(payload);
			notifications.push('success', 'AKM config saved.');
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to save AKM config.';
			notifications.push('error', msg);
		} finally {
			saving = false;
		}
	}

	async function detectEmbedding(): Promise<void> {
		detectingEmbedding = true;
		error = '';
		try {
			const detected = await detectAkmEmbedding();
			embEndpoint = detected.endpoint;
			embModel = detected.model;
			embProvider = detected.provider;
			embDimension = detected.dimension;
			notifications.push('success', detected.message);
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to detect embedding settings.';
			notifications.push('error', msg);
		}
		finally {
			detectingEmbedding = false;
		}
	}

	async function testEmbedding(): Promise<void> {
		testingEmbedding = true;
		error = '';
		try {
			let endpoint = embEndpoint.trim();
			let model = embModel.trim();
			let provider = embProvider.trim();

			if (!endpoint || !model) {
				const detected = await detectAkmEmbedding();
				endpoint = detected.endpoint;
				model = detected.model;
				provider = detected.provider;
				embEndpoint = detected.endpoint;
				embModel = detected.model;
				embProvider = detected.provider;
				embDimension = detected.dimension;
			}

			const result = await testAkmEmbedding({
				endpoint,
				model,
				provider,
				apiKey: embApiKey,
				dimension: embDimension,
			});
			embDimension = result.dimension;
			notifications.push('success', result.message);
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to test embedding settings.';
			notifications.push('error', msg);
		}
		finally {
			testingEmbedding = false;
		}
	}

	async function reindexKnowledge(): Promise<void> {
		reindexing = true;
		try {
			const result = await reindexAkm();
			notifications.push('success', result.message);
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to rebuild the AKM index.';
			notifications.push('error', msg);
		} finally {
			reindexing = false;
		}
	}

	onMount(() => { void load(); });
</script>

<div class="panel" role="tabpanel">
	<div class="panel-header">
		<div>
			<h2>Knowledge</h2>
			<p class="panel-header-sub">Memory · LLM · embedding config</p>
		</div>
		<div class="panel-header-actions">
			<button class="btn btn-secondary btn-sm" onclick={() => void load()} disabled={loading || saving || detectingEmbedding || testingEmbedding || reindexing}>
				{#if loading}<Spinner />{/if}
				Refresh
			</button>
			{#if hostMaintenance}
				<button class="btn btn-secondary btn-sm" onclick={() => void reindexKnowledge()} disabled={loading || saving || detectingEmbedding || testingEmbedding || reindexing}>
					{#if reindexing}<Spinner />{/if}
					Re-index
				</button>
			{/if}
			<button class="btn btn-primary btn-sm" onclick={() => void save()} disabled={loading || saving || detectingEmbedding || testingEmbedding || reindexing}>
				{#if saving}<Spinner />{/if}
				Save
			</button>
		</div>
	</div>

	{#if error}<div class="error-banner"><span>{error}</span></div>{/if}

	<div class="panel-body">

		<!-- ── Knowledge subtab strip ────────────────────────────────────── -->
		<div class="k-tabs" role="tablist" aria-label="Knowledge sections">
			<button
				role="tab"
				class="k-tab"
				class:k-tab--active={knowledgeSection === 'ai-services'}
				aria-selected={knowledgeSection === 'ai-services'}
				onclick={() => { knowledgeSection = 'ai-services'; }}
			>AI Services</button>
			<button
				role="tab"
				class="k-tab"
				class:k-tab--active={knowledgeSection === 'behavior'}
				aria-selected={knowledgeSection === 'behavior'}
				onclick={() => { knowledgeSection = 'behavior'; }}
			>Behavior</button>
			{#if hostMaintenance}
				<button
					role="tab"
					class="k-tab"
					class:k-tab--active={knowledgeSection === 'health-report'}
					aria-selected={knowledgeSection === 'health-report'}
					onclick={() => { knowledgeSection = 'health-report'; }}
				>Health Report</button>
			{/if}
		</div>

		<!-- ── AI Services group (model/agent/improve connections + embedding) ── -->
		{#if knowledgeSection === 'ai-services'}
		{#if hostMaintenance}
			<AkmKnowledgeStatsSection disabled={loading || saving || detectingEmbedding || testingEmbedding || reindexing} />
		{/if}

		<p class="section-note section-note--lead">The AI services your assistant uses to build and search its memory — the language models that organize memories, the embedding provider for semantic search, and the maintenance pipeline.</p>

		<!-- ── LLM Profiles ──────────────────────────────────────────────── -->
		<LlmProfilesSection
			bind:profiles={llmProfiles}
			bind:defaultName={defaultLlmProfile}
			disabled={loading || saving}
			onedit={(p) => openLlmDrawer(p)}
			onadd={() => { drawerLlm = newLlmProfile(); drawerType = 'llm'; }}
			onremove={(id) => removeProfile('llm', id)}
		/>

		<!-- ── Agent Profiles ────────────────────────────────────────────── -->
		<AgentProfilesSection
			bind:profiles={agentProfiles}
			bind:defaultName={defaultAgentProfile}
			disabled={loading || saving}
			onedit={(p) => openAgentDrawer(p)}
			onadd={() => { drawerAgent = newAgentProfile(); drawerType = 'agent'; }}
			onremove={(id) => removeProfile('agent', id)}
		/>

		<!-- ── Improve Profiles ───────────────────────────────────────────── -->
		<ImproveProfilesSection
			bind:profiles={improveProfiles}
			bind:defaultName={defaultImproveProfile}
			disabled={loading || saving}
			onedit={(ip) => openImproveDrawer(ip)}
			onadd={() => { drawerImprove = newImproveProfile(); drawerType = 'improve'; }}
			onremove={(id) => removeProfile('improve', id)}
		/>

		<!-- ── Embedding (semantic search) — part of AI Services ─────────────── -->
		<EmbeddingSection
			bind:endpoint={embEndpoint}
			bind:model={embModel}
			bind:provider={embProvider}
			bind:apiKey={embApiKey}
			bind:dimension={embDimension}
			bind:localModel={embLocalModel}
			bind:batchSize={embBatchSize}
			bind:chunkSize={embChunkSize}
			bind:contextLength={embContextLength}
			bind:ollamaNumCtx={embOllamaNumCtx}
			detecting={detectingEmbedding}
			testing={testingEmbedding}
			ondetect={() => void detectEmbedding()}
			ontest={() => void testEmbedding()}
			disabled={loading || saving || detectingEmbedding || testingEmbedding || reindexing}
		/>

		{/if}<!-- end AI Services group -->

		<!-- ── Behavior group ────────────────────────────────────────────── -->
		{#if knowledgeSection === 'behavior'}

		<!-- ── Behavior + advanced tuning ────────────────────────────────── -->
		<BehaviorSection
			bind:semanticSearchMode
			bind:outputFormat
			bind:outputDetail
			bind:imHalfLife
			bind:imFeedbackBoost
			bind:imEventRetention
			bind:searchMinScore
			bind:searchCurateRerank
			bind:fbRequireReason
			bind:fbFailureModes
			bind:indexJson
			disabled={loading || saving}
		/>

		{/if}<!-- end behavior group -->

		{#if knowledgeSection === 'health-report' && hostMaintenance}
		<AkmHealthReportSection disabled={loading || saving || detectingEmbedding || testingEmbedding || reindexing} />
		{/if}

	</div>

	<!-- ── Slide-in Drawer ───────────────────────────────────────────────────── -->
	{#if drawerType === 'llm' && drawerLlm}
		<LlmProfileDrawer bind:draft={drawerLlm} oncancel={closeDrawer} onapply={applyDrawer} />
	{:else if drawerType === 'agent' && drawerAgent}
		<AgentProfileDrawer bind:draft={drawerAgent} oncancel={closeDrawer} onapply={applyDrawer} />
	{:else if drawerType === 'improve' && drawerImprove}
		<ImproveProfileDrawer bind:draft={drawerImprove} llmProfileNames={llmProfileNames} oncancel={closeDrawer} onapply={applyDrawer} />
	{/if}

</div>

<style>
	/* ── Knowledge subtab strip ─────────────────────────────────────────────── */
	.k-tabs {
		display: flex;
		flex-wrap: nowrap;
		overflow-x: auto;
		min-width: 0;
		max-width: 100%;
		box-sizing: border-box;
		scrollbar-width: none;
		gap: 0;
		border-bottom: var(--s-hair) solid var(--s-line-soft);
	}
	.k-tabs::-webkit-scrollbar { display: none; }
	.k-tab {
		appearance: none;
		border: 0;
		border-bottom: 2px solid transparent;
		background: none;
		cursor: pointer;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		padding: var(--s-sp-2) var(--s-sp-4);
		margin-bottom: -1px;
		white-space: nowrap;
		flex: 1 0 auto;
		min-height: 2.75rem;
	}
	.k-tab:hover { color: var(--s-ink-2); }
	.k-tab:focus-visible { outline: 2px solid var(--s-seal); outline-offset: -2px; }
	.k-tab--active {
		color: var(--s-ink);
		border-bottom-color: var(--s-ink);
	}
	@media (max-width: 400px) {
		.k-tabs { flex-wrap: wrap; overflow-x: visible; }
		.k-tab { font-size: var(--s-type-mark-sm); padding: var(--s-sp-2); }
	}

	/* Panel header */
	h2 {
		font-family: var(--s-font-header);
		font-size: var(--s-type-voice);
		font-weight: 400;
		color: var(--s-ink);
		margin: 0;
	}
	.panel-header-sub {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		margin: var(--s-sp-1) 0 0;
	}

	.panel {
		width: 100%;
		max-width: 100%;
		min-width: 0;
		box-sizing: border-box;
	}
	.panel-body {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-8);
		max-width: 100%;
		min-width: 0;
		box-sizing: border-box;
	}
	.panel-header-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-sp-2);
		max-width: 100%;
		min-width: 0;
	}
	.panel-header-actions :global(.btn) { min-height: 2.75rem; }

	.section-note--lead {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		max-width: 72ch;
		margin: 0 0 var(--s-sp-4);
		overflow-wrap: anywhere;
	}
	.section-note {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
		margin: 0;
	}

	/* Error banner */
	.error-banner {
		display: flex; align-items: center; gap: var(--s-sp-2);
		padding: var(--s-sp-3) var(--s-sp-4);
		border: var(--s-hair) solid var(--s-seal);
		border-radius: 2px;
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-seal);
		margin-bottom: var(--s-sp-4);
	}
</style>
