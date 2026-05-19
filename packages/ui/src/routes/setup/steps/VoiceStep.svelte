<script lang="ts">
  import type { VoiceEngineValue } from '$lib/wizard/types.js';
  import VoiceEngineSelector from '$lib/components/voice/VoiceEngineSelector.svelte';

  interface Props {
    tts: VoiceEngineValue;
    stt: VoiceEngineValue;
    hasOpenAI: boolean;
    onback: () => void;
    onnext: () => void;
    onchangetts: (v: VoiceEngineValue) => void;
    onchangestt: (v: VoiceEngineValue) => void;
  }

  let { tts, stt, hasOpenAI, onback, onnext, onchangetts, onchangestt }: Props = $props();

  const hint = $derived(hasOpenAI
    ? 'OpenAI selected as voice defaults. Kokoro and Whisper recommended for better quality.'
    : 'Browser voice works out of the box. Kokoro and Whisper recommended for higher quality.');
</script>

<h2>Voice Capabilities</h2>
<p class="step-description">Choose how your assistant speaks and listens.</p>

<div id="voice-groups">
  <p class="voice-hint">{hint}</p>

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

<div class="step-actions">
  <button class="btn btn-secondary" id="btn-step3-back" onclick={onback}>Back</button>
  <button class="btn btn-primary" id="btn-step3-next" onclick={onnext}>Options</button>
</div>
