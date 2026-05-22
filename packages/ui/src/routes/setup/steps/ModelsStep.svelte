<script lang="ts">
  import { KNOWN_EMB_DIMS, MAX_VISIBLE_MODELS } from '$lib/wizard/constants.js';
  import type { Provider, ProviderState, ModelSelection, RerankingOptions } from '$lib/wizard/types.js';

  interface ModelOption {
    id: string;
    connId: string;
    providerName: string;
    baseUrl: string;
    isDefault: boolean;
    dims: number;
  }

  interface Props {
    verifiedProviders: Provider[];
    providerState: Record<string, ProviderState>;
    modelSelection: { llm?: ModelSelection; embedding?: ModelSelection; small?: ModelSelection };
    reranking: RerankingOptions;
    errorMessage: string;
    onback: () => void;
    onnext: () => void;
    onselect: (role: string, connId: string, modelId: string, dims: number) => void;
    onselectnone: (role: string) => void;
    onrerankingchange: (updates: Partial<RerankingOptions>) => void;
  }

  let { verifiedProviders, providerState, modelSelection, reranking, errorMessage, onback, onnext, onselect, onselectnone, onrerankingchange }: Props = $props();

  interface Role {
    id: string;
    label: string;
    tag: string;
    desc: string;
  }

  const roles: Role[] = [
    { id: 'llm', label: 'Chat Model (LLM)', tag: 'required', desc: 'Conversations, reasoning, and code' },
    { id: 'embedding', label: 'Embedding Model', tag: 'optional', desc: 'Stash search and recall' },
    { id: 'small', label: 'Small Model', tag: 'optional', desc: 'Lightweight tasks like summarization' },
  ];

  // Per-role filter queries
  let filterQueries = $state<Record<string, string>>({});

  let collapsedRoles = $state<Set<string>>(new Set());

  function toggleCollapse(roleId: string) {
    if (collapsedRoles.has(roleId)) {
      collapsedRoles.delete(roleId);
    } else {
      collapsedRoles.add(roleId);
    }
    collapsedRoles = new Set(collapsedRoles);
  }

  function getOptionsForRole(role: Role): ModelOption[] {
    const options: ModelOption[] = [];
    for (const p of verifiedProviders) {
      const st = providerState[p.id];
      const defaultModel = role.id === 'embedding' ? p.embModel : p.llmModel;
      const models = st.models.length > 0 ? st.models : [];

      if (defaultModel && models.includes(defaultModel)) {
        options.push({
          id: defaultModel,
          connId: p.id,
          providerName: p.name,
          baseUrl: st.baseUrl || p.baseUrl,
          isDefault: true,
          dims: role.id === 'embedding'
            ? (KNOWN_EMB_DIMS[defaultModel] ?? KNOWN_EMB_DIMS[defaultModel.replace(/:.*$/, '')] ?? p.embDims ?? 0)
            : 0,
        });
      }

      for (const m of models) {
        if (m === defaultModel) continue;
        const dims = role.id === 'embedding'
          ? (KNOWN_EMB_DIMS[m] ?? KNOWN_EMB_DIMS[m.replace(/:.*$/, '')] ?? 0)
          : 0;
        options.push({ id: m, connId: p.id, providerName: p.name, baseUrl: st.baseUrl || p.baseUrl, isDefault: false, dims });
      }
    }

    if (role.id === 'embedding') {
      const embOptions = options.filter((o) => o.isDefault || o.dims > 0);
      if (embOptions.length > 0) return embOptions;
    }

    if (role.id === 'small' && options.length === 0) {
      const llmProvider = verifiedProviders[0];
      if (llmProvider) {
        for (const m of providerState[llmProvider.id].models) {
          options.push({
            id: m, connId: llmProvider.id, providerName: llmProvider.name,
            baseUrl: providerState[llmProvider.id].baseUrl || llmProvider.baseUrl,
            isDefault: false, dims: 0,
          });
        }
      }
    }

    return options;
  }

  function filteredOptions(role: Role, options: ModelOption[]): ModelOption[] {
    const query = (filterQueries[role.id] ?? '').toLowerCase().trim();
    if (!query) return options;
    return options.filter((o) => o.id.toLowerCase().includes(query) || o.providerName.toLowerCase().includes(query));
  }

  function handleSelect(role: string, connId: string, modelId: string, dims: number) {
    onselect(role, connId, modelId, dims);
    // Collapse the group after selection so the user can see all three roles at once
    collapsedRoles.add(role);
    collapsedRoles = new Set(collapsedRoles);
  }
</script>

<h2>Choose Your Models</h2>
<p class="step-description">Pre-selected from your providers. Adjust if needed.</p>

{#if verifiedProviders.length === 0}
  <div class="field-error" style="margin-bottom:16px">
    No providers configured. You can skip to complete setup and add providers from the admin panel later.
  </div>
{/if}

<div id="model-groups">
  {#each roles as role}
    {@const options = getOptionsForRole(role)}
    {#if options.length > 0 || role.id === 'small'}
      {@const hasOverflow = options.length > MAX_VISIBLE_MODELS}
      {@const query = filterQueries[role.id] ?? ''}
      {@const visible = filteredOptions(role, options)}
      <div class="model-group">
        <div class="model-group-header" role="button" tabindex="0"
          onclick={() => toggleCollapse(role.id)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleCollapse(role.id); }}
          style="cursor:pointer;user-select:none">
          <span class="model-group-title">{role.label}</span>
          <span class="model-group-tag {role.tag === 'required' ? 'model-group-tag-required' : 'model-group-tag-optional'}">{role.tag}</span>
          {#if collapsedRoles.has(role.id)}
            {@const sel = modelSelection[role.id as 'llm' | 'embedding' | 'small']}
            <span style="flex:1;font-size:var(--text-xs);color:var(--color-text-secondary);margin-left:8px">
              {sel?.model ?? '(none)'}
            </span>
            <span style="font-size:var(--text-xs);color:var(--color-text-secondary)">▶</span>
          {:else}
            <span style="margin-left:auto;font-size:var(--text-xs);color:var(--color-text-secondary)">▼</span>
          {/if}
        </div>

        {#if !collapsedRoles.has(role.id)}
          <div class="model-group-desc">{role.desc}</div>

          {#if role.id === 'small'}
            {@const noneOn = !modelSelection.small?.model}
            <div class="model-opt {noneOn ? 'on' : ''}" role="button" tabindex="0"
              onclick={() => onselectnone('small')}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onselectnone('small'); }}>
              <div class="model-opt-dot"><div class="model-opt-dot-inner"></div></div>
              <div style="flex:1">
                <div class="model-opt-name">(same as chat model)</div>
                <div class="model-opt-meta">No separate small model</div>
              </div>
              <span class="model-opt-badge model-opt-badge-auto">Default</span>
            </div>
          {/if}

          {#if options.length > 3}
            <div class="model-filter-row">
              <input type="text" class="model-filter-input" placeholder="Search {options.length} models…"
                value={query}
                oninput={(e) => { filterQueries[role.id] = (e.currentTarget as HTMLInputElement).value; }}
                autocomplete="off">
            </div>
          {/if}

          {#each query ? visible : options as opt, idx}
            {@const firstDefaultIdx = options.findIndex((o) => o.isDefault)}
            {@const sel = modelSelection[role.id as 'llm' | 'embedding' | 'small']}
            {@const isOn = !!sel && sel.model === opt.id && sel.connId === opt.connId}
            {@const isHidden = !query && hasOverflow && idx >= MAX_VISIBLE_MODELS && !isOn}
            {@const meta = 'via ' + opt.providerName + (opt.dims > 0 ? ' · ' + opt.dims + 'd' : '')}
            <div class="model-opt {isOn ? 'on' : ''} {isHidden ? 'model-opt-filtered' : ''}"
              role="button" tabindex="0"
              data-model-select="{role.id}:{opt.connId}:{opt.id}:{opt.dims}"
              data-model-name={opt.id.toLowerCase()}
              onclick={() => handleSelect(role.id, opt.connId, opt.id, opt.dims)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelect(role.id, opt.connId, opt.id, opt.dims); }}>
              <div class="model-opt-dot"><div class="model-opt-dot-inner"></div></div>
              <div style="flex:1;min-width:0">
                <div class="model-opt-name">{opt.id}</div>
                <div class="model-opt-meta">{meta}</div>
              </div>
              {#if idx === firstDefaultIdx && opt.isDefault}
                <span class="model-opt-badge model-opt-badge-top">Top Pick</span>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  {/each}
</div>

<!-- Search Reranking (moved from Options step) -->
<div class="options-section" style="margin-top:20px">
  <h3 class="options-section-title" style="font-size:var(--text-sm);font-weight:600;margin:0 0 4px">Search Reranking</h3>
  <p style="font-size:var(--text-xs);color:var(--color-text-secondary);margin:0 0 10px">Rerank akm stash results before they reach the assistant.</p>
  <div class="addon-toggle-row">
    <label class="addon-toggle-label">
      <input type="checkbox" id="reranking-enabled" checked={reranking.enabled}
        onchange={(e) => onrerankingchange({ enabled: (e.currentTarget as HTMLInputElement).checked })}>
      <span class="addon-label-text">Enable reranking</span>
    </label>
    <span class="addon-help">Uses the chat model by default.</span>
  </div>
  {#if reranking.enabled}
    <div class="reranking-options" id="reranking-options" style="margin-top:10px">
      <div class="field-group">
        <label for="reranking-mode">Mode</label>
        <select id="reranking-mode" class="field-select"
          value={reranking.mode}
          onchange={(e) => onrerankingchange({ mode: (e.currentTarget as HTMLSelectElement).value as 'llm' | 'dedicated' })}>
          <option value="llm">LLM-based (use chat model)</option>
          <option value="dedicated">Dedicated reranker model</option>
        </select>
      </div>
      {#if reranking.mode === 'dedicated'}
        <div class="field-group">
          <label for="reranking-model">Model</label>
          <input id="reranking-model" type="text" placeholder="e.g. BAAI/bge-reranker-v2-m3"
            value={reranking.model}
            oninput={(e) => onrerankingchange({ model: (e.currentTarget as HTMLInputElement).value })}>
        </div>
      {/if}
      <div class="field-row">
        <div class="field-group field-group-half">
          <label for="reranking-top-k">Top K (candidates)</label>
          <input id="reranking-top-k" type="number" min="1" max="100" value={reranking.topK}
            oninput={(e) => onrerankingchange({ topK: parseInt((e.currentTarget as HTMLInputElement).value, 10) || 20 })}>
        </div>
        <div class="field-group field-group-half">
          <label for="reranking-top-n">Top N (results)</label>
          <input id="reranking-top-n" type="number" min="1" max="50" value={reranking.topN}
            oninput={(e) => onrerankingchange({ topN: parseInt((e.currentTarget as HTMLInputElement).value, 10) || 5 })}>
        </div>
      </div>
    </div>
  {/if}
</div>

<!-- Hidden fields for test compatibility and payload inspection -->
<input type="hidden" id="llm-connection" value={modelSelection.llm?.connId ?? ''}>
<input type="hidden" id="llm-model" value={modelSelection.llm?.model ?? ''}>
<input type="hidden" id="llm-small-model" value={modelSelection.small?.model ?? ''}>
<input type="hidden" id="emb-connection" value={modelSelection.embedding?.connId ?? ''}>
<input type="hidden" id="emb-model" value={modelSelection.embedding?.model ?? ''}>
<input type="hidden" id="emb-dims" value={String(modelSelection.embedding?.dims ?? 1536)}>

{#if errorMessage}
  <div class="field-error" id="step2-error" role="alert">{errorMessage}</div>
{/if}

<div class="step-actions">
  <button class="btn btn-secondary" id="btn-step2-back" onclick={onback}>Back</button>
  <button class="btn btn-primary" id="btn-step2-next" onclick={onnext}>
    {verifiedProviders.length === 0 ? 'Skip for now' : 'Voice Setup'}
  </button>
</div>

<style>
  .addon-toggle-row { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
  .addon-toggle-label { display: flex; align-items: center; gap: 6px; cursor: pointer; white-space: nowrap; }
  .addon-help { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .options-section-title { font-size: var(--text-sm); font-weight: 600; margin: 0 0 4px; color: var(--color-text); }
  .field-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .field-group label { font-size: var(--text-xs); font-weight: 500; color: var(--color-text-secondary); }
  .field-select { padding: 6px 8px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface); font-size: var(--text-sm); }
  .field-row { display: flex; gap: 12px; }
  .field-group-half { flex: 1; }
</style>
