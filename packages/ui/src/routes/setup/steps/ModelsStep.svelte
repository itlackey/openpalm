<script lang="ts">
  import { MAX_VISIBLE_MODELS } from '$lib/wizard/constants.js';
  import { buildModelOptions, type RoleModelOption } from '$lib/wizard/helpers.js';
  import type { Provider, ProviderState, ModelSelection } from '$lib/wizard/types.js';
  import RadioRow from '$lib/components/common/RadioRow.svelte';

  type ModelOption = RoleModelOption;

  interface Props {
    verifiedProviders: Provider[];
    providerState: Record<string, ProviderState>;
    modelSelection: { llm?: ModelSelection; embedding?: ModelSelection; small?: ModelSelection };
    /** True only when the user explicitly opted into a no-AI install. */
    allowEmptyInstall?: boolean;
    /** Single source of truth: a verified provider + chat model, OR empty-install. */
    canComplete?: boolean;
    errorMessage: string;
    onback: () => void;
    onnext: () => void;
    onselect: (role: string, connId: string, modelId: string, dims: number) => void;
    onselectnone: (role: string) => void;
  }

  let { verifiedProviders, providerState, modelSelection, allowEmptyInstall = false, canComplete = false, errorMessage, onback, onnext, onselect, onselectnone }: Props = $props();

  interface Role {
    id: string;
    label: string;
    tag: string;
    desc: string;
  }

  const roles: Role[] = [
    { id: 'llm', label: 'Chat Model', tag: 'required', desc: 'Conversations, reasoning, and code' },
    { id: 'embedding', label: 'Memory Model', tag: 'optional', desc: 'Helps the assistant remember past conversations. Optional.' },
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

  // Single shared builder (wizard/helpers.ts): ranked best-first, embedding
  // models excluded from chat/small, host/cloud ranked over local Ollama. The
  // old per-step copy offered embedding models as chat candidates and, for the
  // small role, fell back to the first provider's ENTIRE list (embeddings too).
  function getOptionsForRole(role: Role): ModelOption[] {
    return buildModelOptions(role.id as 'llm' | 'embedding' | 'small', verifiedProviders, providerState);
  }

  function filteredOptions(role: Role, options: ModelOption[]): ModelOption[] {
    const query = (filterQueries[role.id] ?? '').toLowerCase().trim();
    if (!query) return options;
    return options.filter((o) => o.id.toLowerCase().includes(query) || o.providerName.toLowerCase().includes(query));
  }

  function handleSelect(role: string, connId: string, modelId: string, dims: number) {
    onselect(role, connId, modelId, dims);
    collapsedRoles.add(role);
    collapsedRoles = new Set(collapsedRoles);
  }
</script>

<h2>Choose Your Models</h2>
<p class="step-description">Pre-selected from your providers. Adjust if needed.</p>

{#if verifiedProviders.length === 0}
  {#if allowEmptyInstall}
    <div class="feedback feedback--warning" style="margin-bottom:16px" role="status">
      <span>Installing without an AI provider — the assistant won't be able to chat until you add one from the dashboard. No model selection is needed.</span>
    </div>
  {:else}
    <div class="feedback feedback--error" style="margin-bottom:16px" role="alert">
      <span>Connect a provider on the previous step to choose a chat model.</span>
    </div>
  {/if}
{/if}

<div id="model-groups">
  {#each roles as role}
    {@const options = getOptionsForRole(role)}
    {@const isEmptyEmbedding = role.id === 'embedding' && options.length === 0}
    {#if options.length > 0 || role.id === 'small' || isEmptyEmbedding}
      {@const hasOverflow = options.length > MAX_VISIBLE_MODELS}
      {@const query = filterQueries[role.id] ?? ''}
      {@const visible = filteredOptions(role, options)}
      {@const isCollapsed = collapsedRoles.has(role.id)}
      <div class="model-group">
        <div class="model-group-header" role="button" tabindex="0"
          aria-expanded={!isCollapsed}
          onclick={() => toggleCollapse(role.id)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleCollapse(role.id); }}
          style="cursor:pointer;user-select:none">
          <span class="model-group-title">{role.label}</span>
          <span class="model-group-tag {role.tag === 'required' ? 'model-group-tag-required' : 'model-group-tag-optional'}">{role.tag}</span>
          {#if isCollapsed}
            {@const sel = modelSelection[role.id as 'llm' | 'embedding' | 'small']}
            <span style="flex:1;font-size:var(--text-xs);color:var(--color-text-secondary);margin-left:8px">
              {isEmptyEmbedding && !sel?.model ? 'Automatic' : (sel?.model ?? '(none)')}
            </span>
            <span style="font-size:var(--text-xs);color:var(--color-text-secondary)">▶</span>
          {:else}
            <span style="margin-left:auto;font-size:var(--text-xs);color:var(--color-text-secondary)">▼</span>
          {/if}
        </div>

        {#if !isCollapsed}
          <div class="model-group-desc">{role.desc}</div>

          {#if isEmptyEmbedding}
            <div class="model-auto-note">
              Automatic — the assistant self-embeds locally (akm), so no embedding
              model is configured. Pick one above only if you want to override it.
            </div>
          {/if}

          <!-- Radio group: each role's model list is a single-select group -->
          <div role="radiogroup" aria-label="{role.label} selection">
            {#if role.id === 'small'}
              {@const noneOn = !modelSelection.small?.model}
              <RadioRow
                title="(same as chat model)"
                meta="No separate small model"
                selected={noneOn}
                badgeText="Default"
                badgeTone="auto"
                onSelect={() => onselectnone('small')}
              />
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
              {@const sel = modelSelection[role.id as 'llm' | 'embedding' | 'small']}
              {@const isOn = !!sel && sel.model === opt.id && sel.connId === opt.connId}
              {@const isHidden = !query && hasOverflow && idx >= MAX_VISIBLE_MODELS && !isOn}
              {@const meta = 'via ' + opt.providerName + (opt.dims > 0 ? ' · ' + opt.dims + 'd' : '')}
              <div data-model-name={opt.id.toLowerCase()}>
                <RadioRow
                  title={opt.id}
                  {meta}
                  selected={isOn}
                  hidden={isHidden}
                  value={`${role.id}:${opt.connId}:${opt.id}:${opt.dims}`}
                  badgeText={!query && idx === 0 ? 'Top Pick' : undefined}
                  badgeTone="top"
                  onSelect={() => handleSelect(role.id, opt.connId, opt.id, opt.dims)}
                />
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/each}
</div>

{#if errorMessage}
  <div class="feedback feedback--error" id="step2-error" role="alert"><span>{errorMessage}</span></div>
{/if}

<div class="step-actions">
  <button class="btn btn-secondary" id="btn-step2-back" onclick={onback}>Back</button>
  <button class="btn btn-primary" id="btn-step2-next" onclick={onnext} disabled={!canComplete}>
    {#if verifiedProviders.length === 0 && allowEmptyInstall}
      Skip for now
    {:else}
      Voice Setup
    {/if}
  </button>
</div>
