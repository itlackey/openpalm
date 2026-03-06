<script lang="ts">
  interface Props {
    onSelectCloud: () => void;
    onSelectLocal: () => void;
  }

  let { onSelectCloud, onSelectLocal }: Props = $props();
</script>

<button class="connection-type-card" type="button" onclick={onSelectCloud}>
  <div class="connection-type-icon">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  </div>
  <div class="connection-type-text">
    <span class="connection-type-label">OpenAI-Compatible (Remote)</span>
    <span class="connection-type-desc">API key + optional custom base URL. Works with OpenAI, Groq, Together, OpenRouter, and more.</span>
  </div>
</button>

<button class="connection-type-card" type="button" onclick={onSelectLocal}>
  <div class="connection-type-icon">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <circle cx="6" cy="6" r="1" />
      <circle cx="6" cy="18" r="1" />
    </svg>
  </div>
  <div class="connection-type-text">
    <span class="connection-type-label">Local (Ollama / LM Studio)</span>
    <span class="connection-type-desc">Run models on your own hardware. No API key needed. We can set up Ollama for you.</span>
  </div>
</button>
