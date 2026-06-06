<script lang="ts">
  type Tri = '' | 'on' | 'off';

  // Behavior + advanced tuning. Presentation only — all values bind back to the
  // parent state that load()/save() own.
  interface Props {
    semanticSearchMode?: 'auto' | 'off';
    outputFormat?: 'json' | 'yaml' | 'text';
    outputDetail?: 'brief' | 'normal' | 'full';
    imHalfLife?: string;
    imFeedbackBoost?: string;
    imEventRetention?: string;
    searchMinScore?: string;
    searchCurateRerank?: Tri;
    fbRequireReason?: Tri;
    fbFailureModes?: string;
    indexJson?: string;
    disabled?: boolean;
  }
  let {
    semanticSearchMode = $bindable('auto'),
    outputFormat = $bindable('json'),
    outputDetail = $bindable('brief'),
    imHalfLife = $bindable(''),
    imFeedbackBoost = $bindable(''),
    imEventRetention = $bindable(''),
    searchMinScore = $bindable(''),
    searchCurateRerank = $bindable(''),
    fbRequireReason = $bindable(''),
    fbFailureModes = $bindable(''),
    indexJson = $bindable(''),
    disabled = false,
  }: Props = $props();
</script>

<section class="config-section">
  <h3 class="section-title">Behavior</h3>
  <div class="controls--grid">
    <div class="control-group">
      <label class="control-label" for="semanticSearch">Semantic search</label>
      <select id="semanticSearch" class="control-input" bind:value={semanticSearchMode} {disabled}>
        <option value="auto">Auto (vector index when available)</option>
        <option value="off">Off (keyword only)</option>
      </select>
    </div>
    <div class="control-group">
      <label class="control-label" for="outputFormat">Output format</label>
      <select id="outputFormat" class="control-input" bind:value={outputFormat} {disabled}>
        <option value="json">JSON</option>
        <option value="yaml">YAML</option>
        <option value="text">Text</option>
      </select>
    </div>
    <div class="control-group">
      <label class="control-label" for="outputDetail">Output detail</label>
      <select id="outputDetail" class="control-input" bind:value={outputDetail} {disabled}>
        <option value="brief">Brief</option>
        <option value="normal">Normal</option>
        <option value="full">Full</option>
      </select>
    </div>
  </div>
</section>

<details class="adv-details">
  <summary class="adv-summary">Advanced tuning — affects memory scoring &amp; indexing (leave at defaults unless you know the impact)</summary>
  <section class="config-section adv-body">
    <p class="section-note">Global tuning beyond per-profile settings. Leave blank to use akm defaults.</p>
    <div class="controls--grid">
      <div class="control-group">
        <label class="control-label" for="adv-halflife">Utility decay half-life (days)</label>
        <input id="adv-halflife" class="control-input control-input--narrow" type="number" min="0.1" step="0.1" placeholder="default" bind:value={imHalfLife} {disabled} />
      </div>
      <div class="control-group">
        <label class="control-label" for="adv-fbboost">Feedback stability boost (≥1)</label>
        <input id="adv-fbboost" class="control-input control-input--narrow" type="number" min="1" step="0.1" placeholder="default" bind:value={imFeedbackBoost} {disabled} />
      </div>
      <div class="control-group">
        <label class="control-label" for="adv-eventret">Event retention (days)</label>
        <input id="adv-eventret" class="control-input control-input--narrow" type="number" min="0" placeholder="default" bind:value={imEventRetention} {disabled} />
      </div>
      <div class="control-group">
        <label class="control-label" for="adv-minscore">Search min score</label>
        <input id="adv-minscore" class="control-input control-input--narrow" type="number" min="0" step="0.01" placeholder="default" bind:value={searchMinScore} {disabled} />
      </div>
      <div class="control-group">
        <label class="control-label" for="adv-rerank">Curate rerank</label>
        <select id="adv-rerank" class="control-input" bind:value={searchCurateRerank} {disabled}>
          <option value="">Default</option><option value="on">Enabled</option><option value="off">Disabled</option>
        </select>
      </div>
      <div class="control-group">
        <label class="control-label" for="adv-reqreason">Feedback requires reason</label>
        <select id="adv-reqreason" class="control-input" bind:value={fbRequireReason} {disabled}>
          <option value="">Default</option><option value="on">Required</option><option value="off">Optional</option>
        </select>
      </div>
      <div class="control-group control-group--wide">
        <label class="control-label" for="adv-failmodes">Allowed feedback failure modes (comma-separated)</label>
        <input id="adv-failmodes" class="control-input" type="text" spellcheck="false" placeholder="e.g. outdated, incorrect, irrelevant" bind:value={fbFailureModes} {disabled} />
      </div>
      <div class="control-group control-group--wide">
        <label class="control-label" for="adv-index">Index config (JSON, per-pass)</label>
        <textarea id="adv-index" class="control-input" rows="4" spellcheck="false" placeholder={'{ "enrichment": { "llm": false } }'} bind:value={indexJson} {disabled}></textarea>
        <span class="section-note">Advanced per-pass indexing options (enrichment, graphExtraction, metadataEnhance, stalenessDetection). Must be a JSON object.</span>
      </div>
    </div>
  </section>
</details>

<style>
  .config-section { display: flex; flex-direction: column; gap: var(--space-3); }
  .section-title { font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text); margin: 0; padding-bottom: var(--space-2); border-bottom: 1px solid var(--color-border); }
  .section-note { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0; max-width: 72ch; }
  .controls--grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-4); }
  .control-group { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
  .control-group--wide { grid-column: 1 / -1; }
  .control-label { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); }
  .control-input { font-size: var(--text-sm); color: var(--color-text); background: var(--color-input-bg, var(--color-bg)); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); width: 100%; }
  .control-input--narrow { max-width: 8rem; }
  .control-input:focus { outline: 2px solid var(--color-primary); outline-offset: 1px; }
  .adv-details { border: 1px solid var(--color-border); border-radius: var(--radius-md); margin-top: var(--space-4); }
  .adv-summary { cursor: pointer; padding: var(--space-3) var(--space-4); font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); }
  .adv-summary:hover { background: var(--color-surface-hover); }
  .adv-details[open] .adv-summary { border-bottom: 1px solid var(--color-border); }
  .adv-body { padding: var(--space-4); }
</style>
