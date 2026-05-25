<script lang="ts">
  import type { VoiceEngineValue } from '$lib/wizard/types.js';
  import VoiceEngineSelector from '$lib/components/voice/VoiceEngineSelector.svelte';
  import { TTS_OPTIONS, STT_OPTIONS } from '$lib/wizard/constants.js';

  interface Props {
    tts: VoiceEngineValue;
    stt: VoiceEngineValue;
    hasOpenAI: boolean;
    unknownTts?: boolean;
    unknownStt?: boolean;
    onback: () => void;
    onnext: () => void;
    onchangetts: (v: VoiceEngineValue) => void;
    onchangestt: (v: VoiceEngineValue) => void;
  }

  let { tts, stt, hasOpenAI, unknownTts = false, unknownStt = false, onback, onnext, onchangetts, onchangestt }: Props = $props();

  let configureOpen = $state(false);

  const ttsLabel = $derived(TTS_OPTIONS.find((o) => o.id === tts.engine)?.name ?? 'Browser Built-in');
  const sttLabel = $derived(STT_OPTIONS.find((o) => o.id === stt.engine)?.name ?? 'Browser Built-in');

  // True when either side targets the bundled OpenPalm Voice container.
  // Triggers the first-install download notice — the openpalm/voice
  // image is ~2.4 GB CPU / ~7.6 GB CUDA and the operator should set
  // expectations BEFORE the final Install button instead of staring at
  // the deploy step's spinner for 10 minutes wondering if it's stuck.
  const usesBundledVoice = $derived(
    tts.engine === 'openpalm-voice' || stt.engine === 'openpalm-voice',
  );
</script>

<h2>Voice Capabilities</h2>
<p class="step-description">Browser voice is ready out of the box — no setup needed.</p>

{#if unknownTts || unknownStt}
  <div class="voice-unknown" role="alert">
    Your previous voice settings couldn't be loaded. Please pick an engine.
  </div>
{/if}

{#if usesBundledVoice}
  <div class="voice-download-notice" role="note">
    <strong>First install will download the OpenPalm Voice image.</strong>
    <ul>
      <li>CPU build: ~2.4 GB (5–15 min on a typical home connection)</li>
      <li>CUDA build: ~7.6 GB (15–45 min — chosen later from the admin tab)</li>
    </ul>
    The wizard's final Install step will show a progress indicator and
    wait for the download to finish before completing.
  </div>
{/if}

<div id="voice-summary" class="voice-summary">
  <div class="voice-summary-row">
    <span class="voice-summary-label">Text-to-Speech</span>
    <span class="voice-summary-value">{ttsLabel}</span>
  </div>
  <div class="voice-summary-row">
    <span class="voice-summary-label">Speech-to-Text</span>
    <span class="voice-summary-value">{sttLabel}</span>
  </div>
</div>

<details bind:open={configureOpen} id="voice-configure-details">
  <summary class="voice-configure-summary" id="voice-configure-toggle">Configure voice…</summary>

  <div id="voice-groups" style="margin-top:12px">
    {#if hasOpenAI}
      <p class="voice-hint">OpenAI is available. You can use OpenAI TTS/STT or keep browser voice.</p>
    {:else}
      <p class="voice-hint">Kokoro and Whisper give higher quality. Browser voice works without extra setup.</p>
    {/if}

    <div class="model-group">
      <div class="model-group-header">
        <span class="model-group-title">Text-to-Speech</span>
        <span class="model-group-tag model-group-tag-optional">Optional</span>
      </div>
      <div class="model-group-desc">How your assistant speaks</div>
      <VoiceEngineSelector kind="tts" value={tts} onchange={onchangetts} />
    </div>

    <div class="model-group">
      <div class="model-group-header">
        <span class="model-group-title">Speech-to-Text</span>
        <span class="model-group-tag model-group-tag-optional">Optional</span>
      </div>
      <div class="model-group-desc">How your assistant hears you</div>
      <VoiceEngineSelector kind="stt" value={stt} onchange={onchangestt} />
    </div>
  </div>
</details>

<div class="step-actions">
  <button class="btn btn-secondary" id="btn-step3-back" onclick={onback}>Back</button>
  <button class="btn btn-primary" id="btn-step3-next" onclick={onnext}>Continue</button>
</div>

<style>
  .voice-summary {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    background: var(--color-surface, #f8fafc);
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 8px;
    margin: 12px 0;
  }
  .voice-summary-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--text-sm, 0.875rem);
  }
  .voice-summary-label { color: var(--color-text-secondary, #64748b); }
  .voice-summary-value { font-weight: 500; color: var(--color-text, #1e293b); }
  .voice-configure-summary {
    cursor: pointer;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-primary, #4f6ef7);
    font-weight: 500;
    padding: 4px 0;
    list-style: none;
  }
  .voice-configure-summary::-webkit-details-marker { display: none; }
  .voice-configure-summary::before {
    content: '▶ ';
    font-size: 0.7em;
  }
  details[open] .voice-configure-summary::before { content: '▼ '; }
  .voice-hint {
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text-secondary, #64748b);
    margin: 0 0 12px;
  }
  .voice-unknown {
    margin: 12px 0;
    padding: 10px 14px;
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 8px;
    color: #92400e;
    font-size: var(--text-sm, 0.875rem);
  }
  .voice-download-notice {
    margin: 12px 0 20px;
    padding: 12px 16px;
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    border-radius: 8px;
    color: #1e3a8a;
    font-size: var(--text-sm, 0.875rem);
    line-height: 1.55;
  }
  .voice-download-notice ul {
    margin: 6px 0 6px 18px;
    padding: 0;
  }
  .voice-download-notice strong {
    color: #1e40af;
  }
</style>
