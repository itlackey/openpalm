<script lang="ts">
  import PasswordInput from '$lib/components/PasswordInput.svelte';

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
  }: Props = $props();
</script>

<section class="config-section">
  <h3 class="section-title">Semantic search (embeddings)</h3>
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
</style>
