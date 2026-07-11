<script lang="ts">
  import { voiceState, stopSpeaking } from '$lib/voice/voice-state.svelte.js';
  import IconStop from '@openpalm/ui-kit/components/icons/IconStop.svelte';

  // Review 2026-07-10 K1: /host mounts the bare Navbar (no ChatNavbar/
  // VoiceControl), but `voiceState` is module-level and TTS started on
  // /chat keeps playing across SPA navigation — landing on /host with
  // in-flight speech and no way to stop it there (short of the Voice
  // settings tab). This is a MINIMAL, targeted affordance: just enough to
  // stop in-flight speech from the dashboard. It deliberately does NOT pull
  // in $lib/components/chat/VoiceControl.svelte (mic + chat-state + tray/
  // hotkey wiring) — the chrome-untangle hygiene forbids chat imports in the
  // admin bundle (chrome-untangle-hygiene.vitest.ts) — only the pure
  // $lib/voice/voice-state module, which has no chat/ dependency.
  const isSpeaking = $derived(voiceState.status === 'speaking');
</script>

{#if isSpeaking}
  <button
    type="button"
    class="voice-stop-btn"
    onclick={() => stopSpeaking()}
    aria-label="Stop assistant speech"
    title="Assistant is speaking — click to stop"
  >
    <IconStop size={16} />
    <span class="sr-only">Stop speaking</span>
  </button>
{/if}

<style>
  .voice-stop-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: var(--s-radius-2, 8px);
    border: var(--s-hair) solid var(--s-line);
    background: var(--s-paper);
    color: var(--s-ink);
    cursor: pointer;
  }
  .voice-stop-btn:hover {
    background: var(--s-line-soft);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
