<script lang="ts">
  import { TTS_OPTIONS, STT_OPTIONS } from '$lib/wizard/constants.js';

  interface Props {
    activeTts: string;
    activeStt: string;
    voiceTtsExplicit: string | null;
    voiceSttExplicit: string | null;
    defaultTts: string;
    defaultStt: string;
    hasOpenAI: boolean;
    onback: () => void;
    onnext: () => void;
    onselecttts: (id: string) => void;
    onselectstt: (id: string) => void;
  }

  let { activeTts, activeStt, voiceTtsExplicit, voiceSttExplicit, defaultTts, defaultStt, hasOpenAI, onback, onnext, onselecttts, onselectstt }: Props = $props();

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

    {#each TTS_OPTIONS as o}
      {@const isOn = activeTts === o.id}
      <div class="model-opt {isOn ? 'on' : ''}" role="button" tabindex="0"
        onclick={() => onselecttts(o.id)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onselecttts(o.id); }}>
        <div class="model-opt-dot"><div class="model-opt-dot-inner"></div></div>
        <div style="flex:1;min-width:0">
          <div class="model-opt-name">{o.name}</div>
          <div class="model-opt-meta">{o.desc}</div>
        </div>
        {#if o.recommended}
          <span class="model-opt-badge model-opt-badge-top">Recommended</span>
        {:else if defaultTts === o.id && !voiceTtsExplicit}
          <span class="model-opt-badge model-opt-badge-auto">Auto</span>
        {/if}
      </div>
    {/each}
  </div>

  <div class="model-group">
    <div class="model-group-header">
      <span class="model-group-title">Speech-to-Text</span>
      <span class="model-group-tag model-group-tag-optional">Optional</span>
    </div>
    <div class="model-group-desc">How your assistant hears you</div>

    {#each STT_OPTIONS as o}
      {@const isOn = activeStt === o.id}
      <div class="model-opt {isOn ? 'on' : ''}" role="button" tabindex="0"
        onclick={() => onselectstt(o.id)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onselectstt(o.id); }}>
        <div class="model-opt-dot"><div class="model-opt-dot-inner"></div></div>
        <div style="flex:1;min-width:0">
          <div class="model-opt-name">{o.name}</div>
          <div class="model-opt-meta">{o.desc}</div>
        </div>
        {#if o.recommended}
          <span class="model-opt-badge model-opt-badge-top">Recommended</span>
        {:else if defaultStt === o.id && !voiceSttExplicit}
          <span class="model-opt-badge model-opt-badge-auto">Auto</span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<div class="step-actions">
  <button class="btn btn-secondary" id="btn-step3-back" onclick={onback}>Back</button>
  <button class="btn btn-primary" id="btn-step3-next" onclick={onnext}>Options</button>
</div>
