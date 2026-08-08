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
	import type { LlmEngine, AgentEngine, ImproveStrategy } from '$lib/components/akm/profile-types';

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

	// ── LLM Engines (akm engines.<name>, kind "llm") ─────────────────────────────
	let llmEngines = $state<LlmEngine[]>([]);
	let defaultLlmEngine = $state('');

	// ── Agent Engines (akm engines.<name>, kind "agent") ─────────────────────────
	let agentEngines = $state<AgentEngine[]>([]);
	let defaultAgentEngine = $state('');

	// ── Improve Strategies (akm improve.strategies.<name>) ───────────────────────
	let improveStrategies = $state<ImproveStrategy[]>([]);
	let defaultImproveStrategy = $state('');

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
	let drawerLlm = $state<LlmEngine | null>(null);
	let drawerAgent = $state<AgentEngine | null>(null);
	let drawerImprove = $state<ImproveStrategy | null>(null);

	// ── Derived ──────────────────────────────────────────────────────────────────
	let llmEngineNames = $derived(llmEngines.map(p => p.name).filter(n => n));
	// One akm engines map — improve processes can reference either kind.
	let engineNames = $derived([
		...llmEngines.map(p => p.name),
		...agentEngines.map(p => p.name),
	].filter(n => n));

	// ── Helpers ──────────────────────────────────────────────────────────────────
	function newLlmEngine(): LlmEngine {
		return { id: crypto.randomUUID(), name: '', endpoint: '', model: '', provider: '', apiKey: '', showApiKey: false, temperature: '', maxTokens: '', timeoutMs: '', concurrency: '', contextLength: '', supportsJsonSchema: false, enableThinking: false, extraParams: '' };
	}
	function newAgentEngine(): AgentEngine {
		return { id: crypto.randomUUID(), name: '', platform: 'opencode', bin: '', args: '', workspace: '', model: '', timeoutMs: '', llmEngine: '' };
	}
	function newImproveStrategy(): ImproveStrategy {
		const processes = {} as Record<ProcKey, FEntry>;
		for (const k of PROCESS_KEYS) processes[k] = emptyFEntry(DEFAULT_ENABLED[k]);
		return {
			id: crypto.randomUUID(), name: '', description: '', limit: 25,
			processes, syncEnabled: '', syncPush: '', syncMessage: '',
		};
	}

	// ── Drawer actions ────────────────────────────────────────────────────────────
	function openLlmDrawer(p: LlmEngine) {
		drawerLlm = { ...p };
		drawerType = 'llm';
	}
	function openAgentDrawer(p: AgentEngine) {
		drawerAgent = { ...p };
		drawerType = 'agent';
	}
	function openImproveDrawer(st: ImproveStrategy) {
		const processes = {} as Record<ProcKey, FEntry>;
		for (const k of PROCESS_KEYS) {
			const src = st.processes[k];
			processes[k] = { ...src, judgment: { ...src.judgment }, rest: { ...src.rest } };
		}
		drawerImprove = { ...st, processes };
		drawerType = 'improve';
	}

	// LLM + agent engines share ONE akm engines map — a name can only exist once
	// across the two sections.
	function engineNameCollides(name: string, ownId: string): boolean {
		return llmEngines.some(p => p.id !== ownId && p.name === name)
			|| agentEngines.some(p => p.id !== ownId && p.name === name);
	}

	function applyDrawer() {
		if (drawerType === 'llm' && drawerLlm) {
			const copy = { ...drawerLlm };
			if (copy.name && engineNameCollides(copy.name, copy.id)) {
				notifications.push('error', `Engine name "${copy.name}" is already used by another LLM or agent engine.`);
				return;
			}
			const idx = llmEngines.findIndex(p => p.id === copy.id);
			const oldName = idx >= 0 ? llmEngines[idx].name : '';
			llmEngines = idx >= 0
				? llmEngines.map((p, i) => i === idx ? copy : p)
				: [...llmEngines, copy];
			if (defaultLlmEngine === oldName) defaultLlmEngine = copy.name;
		} else if (drawerType === 'agent' && drawerAgent) {
			const copy = { ...drawerAgent };
			if (copy.name && engineNameCollides(copy.name, copy.id)) {
				notifications.push('error', `Engine name "${copy.name}" is already used by another LLM or agent engine.`);
				return;
			}
			const idx = agentEngines.findIndex(p => p.id === copy.id);
			const oldName = idx >= 0 ? agentEngines[idx].name : '';
			agentEngines = idx >= 0
				? agentEngines.map((p, i) => i === idx ? copy : p)
				: [...agentEngines, copy];
			if (defaultAgentEngine === oldName) defaultAgentEngine = copy.name;
		} else if (drawerType === 'improve' && drawerImprove) {
			const copy = { ...drawerImprove, processes: { ...drawerImprove.processes } };
			const idx = improveStrategies.findIndex(st => st.id === copy.id);
			const oldName = idx >= 0 ? improveStrategies[idx].name : '';
			improveStrategies = idx >= 0
				? improveStrategies.map((st, i) => i === idx ? copy : st)
				: [...improveStrategies, copy];
			if (defaultImproveStrategy === oldName) defaultImproveStrategy = copy.name;
		}
		closeDrawer();
	}

	function closeDrawer() {
		drawerType = null;
		drawerLlm = null;
		drawerAgent = null;
		drawerImprove = null;
	}

	function removeEntry(type: 'llm' | 'agent' | 'improve', id: string) {
		if (type === 'llm') {
			const name = llmEngines.find(p => p.id === id)?.name ?? '';
			if (defaultLlmEngine === name) defaultLlmEngine = '';
			llmEngines = llmEngines.filter(p => p.id !== id);
		} else if (type === 'agent') {
			const name = agentEngines.find(p => p.id === id)?.name ?? '';
			if (defaultAgentEngine === name) defaultAgentEngine = '';
			agentEngines = agentEngines.filter(p => p.id !== id);
		} else {
			const name = improveStrategies.find(st => st.id === id)?.name ?? '';
			if (defaultImproveStrategy === name) defaultImproveStrategy = '';
			improveStrategies = improveStrategies.filter(st => st.id !== id);
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

			llmEngines = form.llmEngines;
			agentEngines = form.agentEngines;
			improveStrategies = form.improveStrategies;
			defaultLlmEngine = form.defaultLlmEngine;
			defaultAgentEngine = form.defaultAgentEngine;
			defaultImproveStrategy = form.defaultImproveStrategy;

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
				llmEngines,
				defaultLlmEngine,
				agentEngines,
				defaultAgentEngine,
				improveStrategies,
				defaultImproveStrategy,
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

		<!-- ── LLM Engines ───────────────────────────────────────────────── -->
		<LlmProfilesSection
			bind:engines={llmEngines}
			bind:defaultName={defaultLlmEngine}
			disabled={loading || saving}
			onedit={(p) => openLlmDrawer(p)}
			onadd={() => { drawerLlm = newLlmEngine(); drawerType = 'llm'; }}
			onremove={(id) => removeEntry('llm', id)}
		/>

		<!-- ── Agent Engines ─────────────────────────────────────────────── -->
		<AgentProfilesSection
			bind:engines={agentEngines}
			bind:defaultName={defaultAgentEngine}
			disabled={loading || saving}
			onedit={(p) => openAgentDrawer(p)}
			onadd={() => { drawerAgent = newAgentEngine(); drawerType = 'agent'; }}
			onremove={(id) => removeEntry('agent', id)}
		/>

		<!-- ── Improve Strategies ─────────────────────────────────────────── -->
		<ImproveProfilesSection
			bind:strategies={improveStrategies}
			bind:defaultName={defaultImproveStrategy}
			disabled={loading || saving}
			onedit={(st) => openImproveDrawer(st)}
			onadd={() => { drawerImprove = newImproveStrategy(); drawerType = 'improve'; }}
			onremove={(id) => removeEntry('improve', id)}
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
		<AgentProfileDrawer bind:draft={drawerAgent} llmEngineNames={llmEngineNames} oncancel={closeDrawer} onapply={applyDrawer} />
	{:else if drawerType === 'improve' && drawerImprove}
		<ImproveProfileDrawer bind:draft={drawerImprove} engineNames={engineNames} oncancel={closeDrawer} onapply={applyDrawer} />
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
