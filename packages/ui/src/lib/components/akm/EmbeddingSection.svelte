<script lang="ts">
  import PasswordInput from '@openpalm/ui-kit/components/common/PasswordInput.svelte';
  import Spinner from '@openpalm/ui-kit/components/common/Spinner.svelte';

  // Embedding / semantic-search connection. All fields are bound back to the
  // parent's state (which load()/save() own) — this component is presentation
  // only.
  interface Props {
    endpoint?: string;
    model?: string;
    provider?: string;
    apiKey?: string;
    dimension?: number;
    localModel?: string;
    batchSize?: string;
    chunkSize?: string;
    contextLength?: string;
    ollamaNumCtx?: string;
    disabled?: boolean;
    detecting?: boolean;
    testing?: boolean;
    ondetect?: () => void;
    ontest?: () => void;
  }
  let {
    endpoint = $bindable(''),
    model = $bindable(''),
    provider = $bindable(''),
    apiKey = $bindable(''),
    dimension = $bindable(1536),
    localModel = $bindable(''),
    batchSize = $bindable(''),
    chunkSize = $bindable(''),
    contextLength = $bindable(''),
    ollamaNumCtx = $bindable(''),
    disabled = false,
    detecting = false,
    testing = false,
    ondetect,
    ontest,
  }: Props = $props();
</script>

<section class="config-section">
  <div class="section-header">
    <h3 class="section-title">Semantic search (embeddings)</h3>
    <div class="section-actions">
      <button class="btn btn-secondary btn-sm" type="button" onclick={ondetect} disabled={disabled || detecting || testing}>
        {#if detecting}<Spinner />{/if}
        Detect
      </button>
      <button class="btn btn-secondary btn-sm" type="button" onclick={ontest} disabled={disabled || detecting || testing}>
        {#if testing}<Spinner />{/if}
        Test
      </button>
    </div>
  </div>
  <p class="section-note">Vector embedding provider for semantic search. Leave Endpoint and Model blank to use built-in local embeddings.</p>
  <div class="controls--grid">
    <div class="control-group control-group--wide">
      <label class="control-label" for="embEndpoint">Endpoint</label>
      <input id="embEndpoint" class="control-input" type="url" spellcheck="false" placeholder="https://api.openai.com/v1/embeddings" bind:value={endpoint} {disabled} />
    </div>
    <div class="control-group">
      <label class="control-label" for="embModel">Model</label>
      <input id="embModel" class="control-input" type="text" spellcheck="false" placeholder="text-embedding-3-small" bind:value={model} {disabled} />
    </div>
    <div class="control-group">
      <label class="control-label" for="embProvider">Provider (label)</label>
      <input id="embProvider" class="control-input" type="text" spellcheck="false" placeholder="openai" bind:value={provider} {disabled} />
    </div>
    <div class="control-group">
      <label class="control-label" for="embApiKey">API Key</label>
      <PasswordInput id="embApiKey" placeholder={'${AKM_EMBED_API_KEY}'} bind:value={apiKey} {disabled} />
    </div>
    <div class="control-group">
      <label class="control-label" for="embDimension">Dimensions</label>
      <input id="embDimension" class="control-input control-input--narrow" type="number" min="1" bind:value={dimension} {disabled} />
    </div>
    <div class="control-group">
      <label class="control-label" for="embLocalModel">Local model</label>
      <input id="embLocalModel" class="control-input" type="text" spellcheck="false" placeholder="Xenova/bge-small-en-v1.5" bind:value={localModel} {disabled} />
    </div>
    <div class="control-group">
      <label class="control-label" for="embBatchSize">Batch size</label>
      <input id="embBatchSize" class="control-input control-input--narrow" type="number" min="1" bind:value={batchSize} {disabled} />
    </div>
    <div class="control-group">
      <label class="control-label" for="embChunkSize">Chunk size (chars)</label>
      <input id="embChunkSize" class="control-input control-input--narrow" type="number" min="1" bind:value={chunkSize} {disabled} />
    </div>
    <div class="control-group">
      <label class="control-label" for="embContextLength">Context length</label>
      <input id="embContextLength" class="control-input control-input--narrow" type="number" min="1" bind:value={contextLength} {disabled} />
    </div>
    <div class="control-group">
      <label class="control-label" for="embOllamaNumCtx">Ollama num_ctx</label>
      <input id="embOllamaNumCtx" class="control-input control-input--narrow" type="number" min="1" bind:value={ollamaNumCtx} {disabled} />
    </div>
  </div>
</section>

<style>
  .config-section { display: flex; flex-direction: column; gap: var(--s-sp-3); }
  .section-header { display: flex; align-items: center; justify-content: space-between; gap: var(--s-sp-3); flex-wrap: wrap; }
  .section-actions { display: flex; gap: var(--s-sp-2); flex-wrap: wrap; }
  .section-title {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    margin: 0;
    padding-bottom: var(--s-sp-2);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }
  .section-note { font-family: var(--s-font-display); font-size: var(--s-type-deed); color: var(--s-ink-3); margin: 0; max-width: 72ch; }
  .controls--grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--s-sp-4); }
  .control-group { display: flex; flex-direction: column; gap: var(--s-sp-2); min-width: 0; }
  .control-group--wide { grid-column: 1 / -1; }
  .control-label { font-family: var(--s-font-mono); font-size: var(--s-type-mark-sm); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-ink-3); }
  .control-input {
    border: 0;
    border-bottom: var(--s-hair) solid var(--s-line);
    background: none;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    padding: 0.5rem 0;
    width: 100%;
  }
  .control-input--narrow { max-width: 8rem; }
  .control-input:focus { outline: none; border-bottom-color: var(--s-ink-2); }
</style>
