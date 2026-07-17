<!--
  VoiceClientSettings — the chat client's speech settings, rendered on the
  /settings/voice page.

  These are CLIENT-owned preferences persisted in this browser (settings in
  localStorage, API keys in the browser secret store) — they never touch the
  host's stack.env. The host side of voice (running the container,
  hardware profile) lives under Admin → Capabilities; this panel only picks
  which provider THIS device talks to:

    browser            — the browser's own Web Speech APIs
    openpalm-voice     — the host's voice container (advertised via /api/runtime)
    openai-compatible  — any OpenAI-shaped /v1/audio endpoint + optional key
    disabled           — no speech on that side
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { notifications } from '$lib/notifications.svelte.js';
  import { getSecretStore } from '$lib/connections/boot.js';
  import { newConnectionId } from '$lib/connections/store.js';
  import {
    loadVoiceSettings,
    saveVoiceSettings,
    voiceSecretsEncryptedAtRest,
    type VoiceClientSettings,
    type VoiceProviderId,
  } from '$lib/voice/settings-store.js';
  import {
    probeVoiceEndpoint,
    refreshAdvertisedVoiceUrl,
  } from '$lib/voice/providers.js';
  import {
    initVoice,
    isIosSafari,
    setTtsAutoEnabled,
    speakText,
    startListening,
    stopListening,
    stopSpeaking,
    voiceState,
  } from '$lib/voice/voice-state.svelte.js';

  type SectionKind = 'stt' | 'tts';
  const MICROPHONE_TEST_MAX_MS = 10_000;
  type SectionForm = {
    provider: VoiceProviderId;
    baseURL: string;
    model: string;
    voice: string;
    language: string;
    apiKey: string;
    secretRef?: string;
    hasStoredKey: boolean;
  };

  function emptyForm(): SectionForm {
    return { provider: 'disabled', baseURL: '', model: '', voice: '', language: '', apiKey: '', hasStoredKey: false };
  }

  let stt = $state<SectionForm>(emptyForm());
  let tts = $state<SectionForm>(emptyForm());
  let autoSpeak = $state(false);

  let openpalmUrl = $state<string | null>(null);
  let openpalmReachable = $state<boolean | null>(null);
  let openpalmChecking = $state(true);
  let browserSttAvailable = $state(false);
  let browserSttReason = $state('');
  let browserTtsAvailable = $state(false);

  let saving = $state(false);
  let speakerTesting = $state(false);
  let microphoneTesting = $state(false);
  let microphoneResult = $state('');
  let microphoneMessage = $state('');
  let speakerMessage = $state('');
  let encryptedKeyStorage = $state(true);
  let error = $state('');
  let microphoneTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    const settings = loadVoiceSettings();
    if (settings) {
      stt = {
        ...emptyForm(),
        provider: settings.stt.provider,
        baseURL: settings.stt.baseURL ?? '',
        model: settings.stt.model ?? '',
        language: settings.stt.language ?? '',
        secretRef: settings.stt.secretRef,
        hasStoredKey: Boolean(settings.stt.secretRef),
      };
      tts = {
        ...emptyForm(),
        provider: settings.tts.provider,
        baseURL: settings.tts.baseURL ?? '',
        model: settings.tts.model ?? '',
        voice: settings.tts.voice ?? '',
        secretRef: settings.tts.secretRef,
        hasStoredKey: Boolean(settings.tts.secretRef),
      };
    }
    autoSpeak = voiceState.ttsAutoEnabled;

    const sr = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (sr && isIosSafari()) {
      browserSttAvailable = false;
      browserSttReason = 'iOS Safari does not support Web Speech recognition';
    } else {
      browserSttAvailable = Boolean(sr);
      browserSttReason = sr ? '' : 'This browser has no Web Speech recognition';
    }
    browserTtsAvailable = 'speechSynthesis' in window;
    encryptedKeyStorage = voiceSecretsEncryptedAtRest();

    void probeOpenpalm();

    // No saved settings yet: mirror the runtime defaults into the form so
    // what the user sees matches what the mic/speaker actually do.
    if (!settings) {
      void (async () => {
        await initVoice();
        stt.provider = voiceState.sttEngine === 'remote' ? 'openai-compatible' : voiceState.sttEngine;
        tts.provider = voiceState.ttsEngine === 'remote' ? 'openai-compatible' : voiceState.ttsEngine;
      })();
    }
  });

  async function probeOpenpalm(): Promise<void> {
    openpalmChecking = true;
    openpalmUrl = await refreshAdvertisedVoiceUrl();
    openpalmReachable = openpalmUrl ? await probeVoiceEndpoint(openpalmUrl) : null;
    openpalmChecking = false;
  }

  function clearMicrophoneTimer(): void {
    if (!microphoneTimer) return;
    clearTimeout(microphoneTimer);
    microphoneTimer = null;
  }

  onDestroy(() => {
    clearMicrophoneTimer();
    if (microphoneTesting) stopListening();
  });

  function sectionToSettings(form: SectionForm, kind: SectionKind) {
    const base: Record<string, string | undefined> = { provider: form.provider };
    if (form.provider === 'openai-compatible') {
      base.baseURL = form.baseURL.trim() || undefined;
      base.model = form.model.trim() || undefined;
      if (kind === 'tts') base.voice = form.voice.trim() || undefined;
      base.secretRef = form.secretRef;
    }
    if (kind === 'stt') base.language = form.language.trim() || undefined;
    return base;
  }

  async function persistKey(form: SectionForm): Promise<void> {
    if (form.provider !== 'openai-compatible') {
      // Switched away from the key-bearing provider: delete the stored key
      // instead of orphaning unreferenced ciphertext in the secret store.
      if (form.secretRef) {
        try { await getSecretStore().delete(form.secretRef); } catch { /* best-effort */ }
        form.secretRef = undefined;
        form.hasStoredKey = false;
      }
      return;
    }
    if (!form.apiKey.trim()) return;
    const secrets = getSecretStore();
    const ref = form.secretRef ?? newConnectionId();
    await secrets.set(ref, { password: form.apiKey.trim() });
    form.secretRef = ref;
    form.hasStoredKey = true;
    form.apiKey = '';
  }

  async function clearStoredKey(form: SectionForm): Promise<void> {
    if (form.secretRef) {
      try { await getSecretStore().delete(form.secretRef); } catch { /* best-effort */ }
    }
    form.secretRef = undefined;
    form.hasStoredKey = false;
    form.apiKey = '';
  }

  /** Returns false when validation failed / the save errored. */
  async function save(): Promise<boolean> {
    error = '';
    if (stt.provider === 'openai-compatible' && !stt.baseURL.trim()) {
      error = 'Speech-to-text: an endpoint URL is required for an OpenAI-compatible provider.';
      return false;
    }
    if (tts.provider === 'openai-compatible' && !tts.baseURL.trim()) {
      error = 'Text-to-speech: an endpoint URL is required for an OpenAI-compatible provider.';
      return false;
    }
    saving = true;
    try {
      await persistKey(stt);
      await persistKey(tts);
      const settings: VoiceClientSettings = {
        version: 1,
        stt: sectionToSettings(stt, 'stt'),
        tts: sectionToSettings(tts, 'tts'),
      } as VoiceClientSettings;
      saveVoiceSettings(settings);
      setTtsAutoEnabled(autoSpeak);
      await initVoice();
      notifications.push('success', 'Voice settings saved for this device.');
      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Save failed.';
      return false;
    } finally {
      saving = false;
    }
  }

  async function testSpeaker(): Promise<void> {
    speakerTesting = true;
    speakerMessage = '';
    error = '';
    try {
      if (!(await save())) return;
      stopSpeaking();
      voiceState.errorMessage = '';
      await speakText('Hello! This is your OpenPalm assistant.');
      if (voiceState.errorMessage) throw new Error(voiceState.errorMessage);
      speakerMessage = 'Speaker test started with the selected provider.';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Speaker test failed.';
    } finally {
      speakerTesting = false;
    }
  }

  async function testMicrophone(): Promise<void> {
    if (microphoneTesting) {
      microphoneMessage = voiceState.status === 'transcribing' ? 'Transcribing…' : 'Transcribing test audio…';
      stopListening();
      return;
    }

    error = '';
    microphoneResult = '';
    microphoneMessage = '';
    if (!(await save())) return;

    stopSpeaking();
    microphoneTesting = true;
    microphoneMessage = 'Listening…';
    microphoneTimer = setTimeout(() => {
      microphoneMessage = 'Transcribing test audio…';
      stopListening();
    }, MICROPHONE_TEST_MAX_MS);

    startListening(
      (transcript) => {
        microphoneResult = transcript;
      },
      () => {
        clearMicrophoneTimer();
        microphoneTesting = false;
        microphoneMessage = microphoneResult
          ? 'Microphone test complete.'
          : voiceState.errorMessage || 'No speech detected.';
      },
    );
  }
</script>

<section class="voice-settings" aria-label="Voice settings">
  <h2>Speech providers</h2>
  <p class="lede">
    Choose the speech-to-text and text-to-speech providers used by this browser.
  </p>

  <div class="voice-grid">
    {#each [
      { kind: 'stt' as const, form: stt, title: 'Speech to text (microphone)' },
      { kind: 'tts' as const, form: tts, title: 'Text to speech (speaker)' },
    ] as section (section.kind)}
      {@const form = section.form}
      <div class="voice-card">
        <h3>{section.title}</h3>
        <label class="field">
          <span>Provider</span>
          <select bind:value={form.provider}>
            <option value="openpalm-voice">OpenPalm Voice (this host)</option>
            <option
              value="browser"
              disabled={section.kind === 'stt' ? !browserSttAvailable : !browserTtsAvailable}
            >
              Browser speech {section.kind === 'stt' && !browserSttAvailable ? `— ${browserSttReason}` : ''}
            </option>
            <option value="openai-compatible">OpenAI-compatible endpoint</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>

        {#if form.provider === 'openpalm-voice'}
          {#if openpalmChecking}
            <p class="hint">Checking this host’s voice service…</p>
          {:else if openpalmUrl && openpalmReachable === true}
            <p class="hint status-ok">
              Available on this host.
            </p>
          {:else if openpalmUrl}
            <p class="hint status-warn">
              Advertised by this host, but not reachable. It may still be starting.
              <button type="button" class="linklike" onclick={() => void probeOpenpalm()}>Re-check</button>.
            </p>
          {:else}
            <p class="hint status-warn">
              ○ This host is not offering a voice service. Enable the Voice capability in
              Admin → Capabilities, then <button type="button" class="linklike" onclick={() => void probeOpenpalm()}>re-check</button>.
            </p>
          {/if}
        {/if}

        {#if form.provider === 'openai-compatible'}
          <label class="field">
            <span>Endpoint URL</span>
            <input type="url" bind:value={form.baseURL} placeholder="https://api.openai.com/v1" autocomplete="off" />
            <small>Your provider's OpenAI base URL (e.g. <code>https://api.openai.com/v1</code>). The <code>/v1</code> is optional — it's added if you leave it off.</small>
          </label>
          <label class="field">
            <span>Model</span>
            <input type="text" bind:value={form.model} placeholder={section.kind === 'stt' ? 'whisper-1' : 'tts-1'} autocomplete="off" />
          </label>
          {#if section.kind === 'tts'}
            <label class="field">
              <span>Voice</span>
              <input type="text" bind:value={form.voice} placeholder="alloy" autocomplete="off" />
            </label>
          {/if}
          <label class="field">
            <span>API key {form.hasStoredKey ? '(stored — leave blank to keep)' : '(optional)'}</span>
            <input type="password" bind:value={form.apiKey} autocomplete="new-password" />
            {#if encryptedKeyStorage}
              <small>Stored encrypted in this browser only, like connection passwords.</small>
            {:else}
              <small>
                Stored in this browser without at-rest encryption because this page uses an insecure
                HTTP origin. Use HTTPS or the local desktop app for encrypted storage.
              </small>
            {/if}
            {#if form.hasStoredKey}
              <button type="button" class="linklike" onclick={() => void clearStoredKey(form)}>
                Clear stored key
              </button>
            {/if}
          </label>
        {/if}

        {#if section.kind === 'stt' && form.provider !== 'disabled'}
          <label class="field">
            <span>Language (optional)</span>
            <input type="text" bind:value={form.language} placeholder="en" autocomplete="off" />
          </label>
        {/if}
      </div>
    {/each}
  </div>

  <label class="field-inline">
    <input type="checkbox" bind:checked={autoSpeak} />
    <span>Speak replies automatically</span>
  </label>

  <div class="test-grid">
    <div class="test-panel">
      <strong>Microphone test</strong>
      <p>Records for up to 10 seconds and transcribes with the selected provider. The transcript stays in this panel and is never sent to the assistant.</p>
      <button
        type="button"
        class="btn btn-secondary"
        onclick={() => void testMicrophone()}
        disabled={saving || speakerTesting || stt.provider === 'disabled'}
      >
        {microphoneTesting
          ? voiceState.status === 'transcribing'
            ? 'Transcribing…'
            : 'Stop and transcribe'
          : 'Test microphone'}
      </button>
      {#if microphoneMessage}
        <small aria-live="polite">{microphoneMessage}</small>
      {/if}
      {#if microphoneResult}
        <output class="test-result" aria-label="Microphone test transcript">{microphoneResult}</output>
      {/if}
    </div>
    <div class="test-panel">
      <strong>Speaker test</strong>
      <p>Uses only the selected text-to-speech provider and reports a provider failure without fallback.</p>
      <button
        type="button"
        class="btn btn-secondary"
        onclick={() => void testSpeaker()}
        disabled={saving || speakerTesting || microphoneTesting || tts.provider === 'disabled'}
      >
        {speakerTesting ? 'Testing…' : 'Test speaker'}
      </button>
      {#if speakerMessage}
        <small class="status-ok" aria-live="polite">{speakerMessage}</small>
      {/if}
    </div>
  </div>

  {#if error}
    <div class="alert error" role="alert">{error}</div>
  {/if}

  <div class="form-actions">
    <button type="button" class="btn btn-primary" onclick={() => void save()} disabled={saving || speakerTesting || microphoneTesting}>
      {saving ? 'Saving…' : 'Save voice settings'}
    </button>
  </div>
</section>

<style>
  .voice-settings {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
    padding: var(--s-sp-5);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper);
  }
  .voice-settings h2 {
    margin: 0;
  }
  .lede {
    color: var(--s-ink-3);
    margin: 0;
  }

  .voice-grid {
    width: 100%;
    min-width: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
    gap: var(--s-sp-4);
  }

  .voice-card {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
    padding: var(--s-sp-4);
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 2px;
  }
  .voice-card h3 {
    margin: 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
  }

  .field {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
  }
  .field > span {
    font-size: var(--s-type-deed);
    font-weight: 500;
  }
  .field input,
  .field select {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    padding: var(--s-sp-2) var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    font: inherit;
    background: var(--s-paper);
    color: var(--s-ink);
  }
  .field small {
    color: var(--s-ink-3);
    font-size: var(--s-type-deed);
  }
  .field code {
    font-family: var(--s-font-mono);
    background: var(--s-paper-deep);
    padding: 1px 4px;
    border-radius: 4px;
  }

  .hint {
    margin: 0;
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
  }
  .status-ok {
    color: var(--s-moss, var(--s-ink-2));
  }
  .status-warn {
    color: var(--s-ink-2);
  }
  .linklike {
    background: none;
    border: none;
    padding: 0;
    color: var(--s-seal);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }

  .field-inline {
    display: flex;
    align-items: center;
    min-height: 44px;
    gap: var(--s-sp-2);
    cursor: pointer;
  }
  .field-inline input {
    box-sizing: border-box;
    width: 24px;
    min-width: 24px;
    height: 24px;
    margin: 0;
  }

  .test-grid {
    width: 100%;
    min-width: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
    gap: var(--s-sp-3);
  }
  .test-panel {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-sp-2);
    padding: var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line-soft);
  }
  .test-panel p {
    margin: 0;
    color: var(--s-ink-3);
    font-size: var(--s-type-deed);
  }
  .test-panel small {
    color: var(--s-ink-3);
  }
  .test-result {
    box-sizing: border-box;
    width: 100%;
    padding: var(--s-sp-2);
    border: var(--s-hair) solid var(--s-line-soft);
    background: var(--s-paper-deep);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
  }

  .alert.error {
    padding: var(--s-sp-3);
    border-radius: 2px;
    background: color-mix(in srgb, var(--s-seal) 8%, transparent);
    color: var(--s-seal);
    border: 1px solid color-mix(in srgb, var(--s-seal) 25%, transparent);
  }

  .form-actions {
    display: flex;
    gap: var(--s-sp-2);
  }

  button {
    min-width: 44px;
    min-height: 44px;
  }

  .field input:focus-visible,
  .field select:focus-visible,
  .field-inline input:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--s-ink);
    outline-offset: 2px;
  }
</style>
