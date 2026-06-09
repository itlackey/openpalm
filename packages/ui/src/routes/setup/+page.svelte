<script lang="ts">
  import { onMount } from 'svelte';
  import {
    PROVIDERS, LOCAL_PROVIDERS, CHANNELS, OLLAMA_DEFAULT_CHAT_MODEL,
  } from '$lib/wizard/constants.js';
  import { buildModelOptions, selectAddonProfileId } from '$lib/wizard/helpers.js';
  import type {
    ProviderState, ModelSelection, DetectedProvider, ChannelState,
    OpenCodeProvider, AuthMethod, VoiceEngineValue,
  } from '$lib/wizard/types.js';
  import type { VoiceAddonProfile } from '$lib/api.js';
  import type { SetupRecommendation } from '@openpalm/lib';
  import { friendlyError, type FriendlyErrorView } from '$lib/wizard/error-messages.js';
  import ProgressBar from './ProgressBar.svelte';
  import SystemCheckStep from './steps/SystemCheckStep.svelte';
  import WelcomeStep from './steps/WelcomeStep.svelte';
  import ProvidersStep from './steps/ProvidersStep.svelte';
  import ModelsStep from './steps/ModelsStep.svelte';
  import VoiceStep from './steps/VoiceStep.svelte';
  import OptionsStep from './steps/OptionsStep.svelte';
  import ReviewStep from './steps/ReviewStep.svelte';
  import DeployStep from './steps/DeployStep.svelte';

  interface OAuthAuthorizeResponse {
    url?: string;
    method?: 'auto' | 'code';
    instructions?: string;
    message?: string;
  }

  // ── Navigation state ─────────────────────────────────────────────────────
  let currentStep = $state(0);
  let maxVisitedStep = $state(0);
  let showDeploy = $state(false);
  let systemCheckPassed = $state(false);

  // ── Step 0: Welcome ───────────────────────────────────────────────────────
  // Operator UI login password — replaces the legacy "admin token" UI
  // (Phase 4 of docs/technical/auth-and-proxy-refactor-plan.md). Persisted
  // to stack.env as OP_UI_LOGIN_PASSWORD.
  let uiLoginPassword = $state('');
  let step0Error = $state('');
  // Tracks whether the "Use recommended defaults" detection has settled
  let detectionReady = $state(false);
  // True while auto mode is performing a host provider import before jumping to Review
  let autoModeImporting = $state(false);
  // Enable Voice toggle on the Welcome step (auto-mode only)
  // enableVoice is DERIVED from the voice engines (declared after voiceTts/Stt
  // below) — it is not its own state. See the $derived near the voice engines.
  // Include Ollama in the stack toggle on the Welcome step
  let includeOllama = $state(false);
  // Set when System Check detects a GPU — used to auto-select CUDA voice profile
  let gpuDetected = $state(false);

  // ── Step 1: Providers ─────────────────────────────────────────────────────
  let providerState = $state<Record<string, ProviderState>>({});
  // Local LLM runtimes detected running on the host (ollama/lmstudio/model-runner),
  // from /api/setup/recommend. When present, the in-stack Ollama addon is redundant.
  let detectedHostProviders = $state<{ provider: string; url: string }[]>([]);
  const hostLocalLlmRunning = $derived(
    providerState['ollama']?.ollamaMode === 'running' ||
      detectedHostProviders.some((p) => p.provider === 'ollama' || p.provider === 'lmstudio'),
  );
  let expandedProvider = $state<string | null>(null);
  let detectedProviders = $state<DetectedProvider[]>([]);
  let detecting = $state(false);
  let opencodeAvailable = $state(false);
  let opencodeProviders = $state<OpenCodeProvider[]>([]);
  let opencodeAuth = $state<Record<string, AuthMethod[]>>({});
  let ocFilterQuery = $state('');
  // Host import detection
  let hostProviderCount = $state(0);
  let hostStatusWarning = $state<string | null>(null);
  let allowEmptyInstall = $state(false);
  // Setup recommendation (from /api/setup/recommend) — drives auto-configuration
  // of providers/Ollama based on detected cloud providers, host providers + GPU.
  let recommendation = $state<SetupRecommendation | null>(null);
  let recommendationAlert = $state('');
  let recommendationApplied = $state(false);
  let voiceEngineUnknownTts = $state(false);
  let voiceEngineUnknownStt = $state(false);
  /** Generation counter per provider — discard stale verify results */
  const verifyGeneration: Record<string, number> = {};
  /** AbortControllers for in-flight OAuth long-poll requests */
  const oauthAbortControllers: Record<string, AbortController> = {};

  // ── Step 2: Models ────────────────────────────────────────────────────────
  let modelSelection = $state<{ llm?: ModelSelection; embedding?: ModelSelection; small?: ModelSelection }>({});
  let step2Error = $state('');
  let step2EmbDimWarning = $state('');

  // ── Step 3: Voice ─────────────────────────────────────────────────────────
  // VoiceEngineValue holds engine id + per-engine settings (model/voice/language).
  // Empty engine = not yet chosen; we fall back to voiceDefaults at render time.
  let voiceTts = $state<VoiceEngineValue>({ engine: '' });
  let voiceStt = $state<VoiceEngineValue>({ engine: '' });

  // "Voice enabled" = the bundled OpenPalm Voice engine is selected on either
  // side. DERIVED (not manually-synced state) so it can never drift from the
  // engines after rerun deserialization or any out-of-band engine edit.
  const enableVoice = $derived(
    voiceTts.engine === 'openpalm-voice' || voiceStt.engine === 'openpalm-voice',
  );
  // Hardware profiles for the bundled OpenPalm Voice addon (CPU / CUDA / …)
  let voiceProfiles = $state<VoiceAddonProfile[]>([]);
  let selectedVoiceProfile = $state('');

  // Imported OpenCode model preferences (from host opencode.json)
  let importedLlmModel = $state<string | undefined>(undefined);
  let importedSmallModel = $state<string | undefined>(undefined);

  // ── Step 4: Options ───────────────────────────────────────────────────────
  let channelSelection = $state<Record<string, boolean | ChannelState>>({
    discord: { enabled: false, botToken: '', applicationId: '' },
    slack: { enabled: false, slackBotToken: '', slackAppToken: '' },
  });
  let ollamaEnabled = $state(false);
  // Guard so the Options-step auto-sync from ollamaMode runs at most ONCE and
  // never clobbers a restored (rerun) value or a user's explicit toggle when
  // they navigate back and forth.
  let ollamaEnabledInitialized = $state(false);
  let ollamaProfiles = $state<VoiceAddonProfile[]>([]);
  let selectedOllamaProfile = $state('');
  let imageTag = $state('');
  let hostAkmEnabled = $state(false);
  let hostAkmAvailable = $state(false);
  let step4Error = $state('');

  // ── Step 5: Review + Install ──────────────────────────────────────────────
  let installError = $state('');
  let installing = $state(false);
  // Single explicit acknowledgment for an empty-AI install — replaces the
  // scattered soft warnings. Set true once the user confirms the prompt.
  let emptyAiAck = $state(false);

  // ── Deploy screen ─────────────────────────────────────────────────────────
  let deployData = $state<{
    deploying?: boolean;
    setupComplete?: boolean;
    deployStatus?: { service: string; status: string; label?: string }[];
    deployError?: string | null;
    ports?: { admin?: number; assistant?: number };
  }>({});
  let deployDone = $state(false);
  // True when the deploy reached a terminal state but one or more non-running
  // rows are warnings (e.g. voice still warming). Setup IS complete — this is a
  // "Done (with warnings)" terminal state, not an error.
  let deployHasWarnings = $state(false);
  let deployError = $state<string | null>(null);
  let deployTimer: ReturnType<typeof setInterval> | null = null;
  let deployPollErrors = $state(0);
  let lastDeployData = $state<{ service: string; status: string; label?: string }[] | null>(null);

  // ── Derived ───────────────────────────────────────────────────────────────
  const verifiedCount = $derived.by(() => {
    const ids = opencodeAvailable
      ? opencodeProviders.map((p) => p.id)
      : PROVIDERS.map((p) => p.id);
    return ids.filter((id) => providerState[id]?.verified).length;
  });

  const verifiedProviders = $derived.by(() => {
    if (opencodeAvailable) {
      const fromOpenCode = opencodeProviders
        .filter((p) => providerState[p.id]?.verified)
        .map((p) => {
          const st = providerState[p.id];
          // Inherit llmModel/embModel/embDims from the fallback list for local providers
          // (Ollama → nomic-embed-text, model-runner → mxbai-embed-large, etc.)
          const fallback = PROVIDERS.find((fp) => fp.id === p.id);
          return {
            id: p.id, name: p.name ?? p.id, kind: 'cloud' as const, group: '', order: 0,
            icon: '', desc: '', baseUrl: st?.baseUrl ?? '',
            llmModel: fallback?.llmModel ?? '',
            embModel: fallback?.embModel ?? '',
            embDims: fallback?.embDims ?? 0,
          };
        });
      // Also include verified static providers not already in the OpenCode list
      // (e.g. Ollama added by the wizard's "Include Ollama" toggle)
      const openCodeIds = new Set(fromOpenCode.map((p) => p.id));
      const fromStatic = PROVIDERS
        .filter((p) => !openCodeIds.has(p.id) && providerState[p.id]?.verified)
        .map((p) => {
          const st = providerState[p.id];
          return {
            id: p.id, name: p.name, kind: p.kind, group: p.group, order: p.order,
            icon: p.icon, desc: p.desc, baseUrl: st?.baseUrl ?? p.baseUrl,
            llmModel: p.llmModel, embModel: p.embModel, embDims: p.embDims,
          };
        });
      return [...fromOpenCode, ...fromStatic];
    }
    return PROVIDERS.filter((p) => providerState[p.id]?.verified);
  });

  const hasOllamaVerified = $derived(
    PROVIDERS.some((p) => p.id === 'ollama' && providerState[p.id]?.verified)
  );

  // ── Single source of truth for "can the user finish setup?" ──────────────
  // ONE predicate drives the Providers Next button, the Models Next button,
  // AND the Review/Install gate. The wizard must never simultaneously offer
  // "continue without a provider" and error "a provider is required".
  //   - A verified provider + a chosen chat model → ready.
  //   - OR the user explicitly opted into an empty (no-AI) install.
  const hasVerifiedProvider = $derived(verifiedProviders.length > 0);
  // Once a provider is verified you must pick a chat model; the empty-install
  // opt-in only governs the no-provider case. Expressed as a derived predicate
  // (not a state-mutating $effect that flipped `allowEmptyInstall` off on every
  // background verification — that silently moved the checkbox under the user).
  const canComplete = $derived(
    hasVerifiedProvider ? !!modelSelection.llm?.model : allowEmptyInstall,
  );

  const hasOpenAI = $derived(
    PROVIDERS.some((p) => p.id === 'openai' && providerState[p.id]?.verified)
  );

  const voiceDefaults = $derived(hasOpenAI
    ? { tts: 'openai-tts', stt: 'openai-stt' }
    : { tts: 'browser-tts', stt: 'browser-stt' });

  const displayedVoiceTts = $derived.by(() => {
    if (voiceTts.engine) return voiceTts;
    if (enableVoice) return { engine: 'openpalm-voice' };
    return { engine: voiceDefaults.tts };
  });

  const displayedVoiceStt = $derived.by(() => {
    if (voiceStt.engine) return voiceStt;
    if (enableVoice) return { engine: 'openpalm-voice' };
    return { engine: voiceDefaults.stt };
  });

  const persistedVoiceTts = $derived.by(() => {
    if (voiceTts.engine) return voiceTts;
    if (enableVoice) return { engine: 'openpalm-voice' };
    return { engine: '' };
  });

  const persistedVoiceStt = $derived.by(() => {
    if (voiceStt.engine) return voiceStt;
    if (enableVoice) return { engine: 'openpalm-voice' };
    return { engine: '' };
  });

  const selectedVoiceProfileLabel = $derived.by(() => {
    if (!selectedVoiceProfile) return '';
    const profile = voiceProfiles.find((p) => p.id === selectedVoiceProfile);
    return profile?.label ?? profile?.id ?? selectedVoiceProfile;
  });

  const selectedOllamaProfileLabel = $derived.by(() => {
    if (!selectedOllamaProfile) return '';
    const profile = ollamaProfiles.find((p) => p.id === selectedOllamaProfile);
    return profile?.label ?? profile?.id ?? selectedOllamaProfile;
  });

  function addonProfileId(addon: 'voice' | 'ollama', variant: 'cpu' | 'cuda' | 'rocm'): string {
    return `addon.${addon}.${variant}`;
  }


  // Build the install payload for /api/setup/complete
  const payload = $derived.by(() => {
    const llm = modelSelection.llm;
    const emb = modelSelection.embedding;
    const small = modelSelection.small;

    const capabilityProviderIds: Record<string, boolean> = {};
    if (llm) capabilityProviderIds[llm.connId] = true;
    if (emb) capabilityProviderIds[emb.connId] = true;
    if (small?.model) capabilityProviderIds[small.connId] = true;

    const capabilities = verifiedProviders
      .filter((p) => capabilityProviderIds[p.id])
      .map((p) => {
        const st = providerState[p.id];
        return { id: p.id, name: p.name, provider: p.id, baseUrl: st?.baseUrl ?? p.baseUrl, apiKey: st?.apiKey ?? '' };
      });

    const llmConnId = llm?.connId ?? '';
    const embConnId = emb?.connId ?? '';
    const llmCap = capabilities.find((c) => c.id === llmConnId);
    const embCap = capabilities.find((c) => c.id === embConnId);
    const llmProvider = llmCap?.provider ?? '';
    const embProvider = embCap?.provider ?? '';

    const addons: Record<string, boolean> = {};
    // Suppress the in-stack Ollama addon when a host Ollama/LM Studio is running
    // (redundant; the toggle is disabled in that case).
    if (ollamaEnabled && !hostLocalLlmRunning) addons.ollama = true;
    // Enable the bundled voice addon when either side targets it.
    // performSetup -> setAddonEnabled copies the compose overlay, then
    // startDeploy's composePull picks up the openpalm/voice image so
    // it lands in the same first-install pull cycle as the rest of the
    // stack.
    if (persistedVoiceTts.engine === 'openpalm-voice' || persistedVoiceStt.engine === 'openpalm-voice') {
      addons.voice = true;
    }

    const channelCredentials: Record<string, Record<string, string>> = {};
    const channelsConfig = buildChannelsConfig();
    for (const chId of Object.keys(channelsConfig)) {
      const chVal = channelsConfig[chId];
      if (chVal === true) {
        addons[chId] = true;
      } else if (typeof chVal === 'object' && chVal !== null) {
        addons[chId] = true;
        const creds: Record<string, string> = {};
        for (const key of Object.keys(chVal)) {
          if (key !== 'enabled' && chVal[key]) {
            creds[key] = String(chVal[key]);
          }
        }
        if (Object.keys(creds).length > 0) channelCredentials[chId] = creds;
      }
    }

    const result: Record<string, unknown> = {
      version: 2,
      addons,
      security: { uiLoginPassword },
      connections: capabilities,
    };

    // LLM and embedding go directly to akm config (config/akm/config.json)
    if (llmProvider && llm?.model) {
      result.llm = { provider: llmProvider, model: llm.model, baseUrl: llmCap?.baseUrl ?? '' };
    }
    if (embProvider && emb?.model) {
      result.embedding = { provider: embProvider, model: emb.model, dims: emb.dims ?? 1536, baseUrl: embCap?.baseUrl ?? '' };
    }

    // Voice engines — only persist if the user picked something explicit
    // and it isn't the "skip" sentinel.
    // If engine is empty (not yet chosen, or rerun with missing engine),
    // omit the field entirely to leave any existing server config intact.
    const voicePayload = (v: VoiceEngineValue) => {
      if (!v.engine || v.engine.startsWith('skip-')) return undefined;
      const out: Record<string, unknown> = { enabled: true, engine: v.engine };
      if (v.provider) out.provider = v.provider;
      if (v.baseURL) out.baseURL = v.baseURL;
      if (v.model) out.model = v.model;
      if (v.voice) out.voice = v.voice;
      if (v.language) out.language = v.language;
      return out;
    };
    const ttsCap = voicePayload(persistedVoiceTts);
    if (ttsCap) result.tts = ttsCap;
    const sttCap = voicePayload(persistedVoiceStt);
    if (sttCap) result.stt = sttCap;

    // Include the selected hardware profile when using the bundled voice addon
    if ((persistedVoiceTts.engine === 'openpalm-voice' || persistedVoiceStt.engine === 'openpalm-voice') && selectedVoiceProfile) {
      result.voiceProfile = selectedVoiceProfile;
    }

    // Include the Ollama hardware profile when Ollama is enabled in-stack
    if (ollamaEnabled && selectedOllamaProfile) {
      result.ollamaProfile = selectedOllamaProfile;
    }

    if (Object.keys(channelCredentials).length > 0) {
      result.channelCredentials = channelCredentials;
    }

    if (imageTag.trim()) result.imageTag = imageTag.trim();
    if (hostAkmEnabled) result.hostAkm = true;

    return result;
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function generatePassword(): string {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function buildChannelsConfig(): Record<string, boolean | Record<string, string | boolean>> {
    const result: Record<string, boolean | Record<string, string | boolean>> = {};
    for (const ch of CHANNELS) {
      const sel = channelSelection[ch.id];
      if (ch.locked) {
        result[ch.id] = true;
      } else if (typeof sel === 'object' && sel !== null) {
        if (sel.enabled) {
          const entry: Record<string, string | boolean> = { enabled: true };
          if (ch.credentials) {
            for (const cred of ch.credentials) {
              const v = sel[cred.key];
              if (v) entry[cred.key] = v;
            }
          }
          result[ch.id] = entry;
        }
      } else if (sel) {
        result[ch.id] = true;
      }
    }
    return result;
  }

  async function loadVoiceProfiles(): Promise<void> {
    try {
      const res = await fetch('/api/setup/voice-profiles');
      if (!res.ok) return;
      const data = await res.json() as {
        ok?: boolean;
        profiles?: VoiceAddonProfile[];
        selectedProfile?: string | null;
      };
      if (!Array.isArray(data.profiles)) return;
      voiceProfiles = data.profiles;

      // Auto-select the best profile: CUDA if GPU detected, otherwise CPU/default.
      const fallback = selectAddonProfileId(data.profiles, 'voice', gpuDetected);
      if (fallback) selectedVoiceProfile = fallback;

      // gpuDetected may have been set after this fetch started — upgrade now
      if (gpuDetected && selectedVoiceProfile !== addonProfileId('voice', 'cuda')) {
        const cuda = voiceProfiles.find((p) => p.id === addonProfileId('voice', 'cuda') && p.available !== false);
        if (cuda) selectedVoiceProfile = cuda.id;
      }
    } catch {
      // non-critical
    }
  }

  async function loadOllamaProfiles(): Promise<void> {
    try {
      const res = await fetch('/api/setup/ollama-profiles');
      if (!res.ok) return;
      const data = await res.json() as {
        ok?: boolean;
        profiles?: VoiceAddonProfile[];
        selectedProfile?: string | null;
      };
      if (!Array.isArray(data.profiles)) return;
      ollamaProfiles = data.profiles;

      const fallback = gpuDetected
        ? data.profiles.find((p) => p.id === addonProfileId('ollama', 'cuda') && p.available !== false)
          ?? data.profiles.find((p) => p.default && p.available !== false)
          ?? data.profiles.find((p) => p.available !== false)
        : data.profiles.find((p) => p.id === addonProfileId('ollama', 'cpu') && p.available !== false)
          ?? data.profiles.find((p) => p.default && p.available !== false)
          ?? data.profiles.find((p) => p.available !== false);
      if (data.selectedProfile && typeof data.selectedProfile === 'string') {
        selectedOllamaProfile = data.selectedProfile;
      } else if (fallback) {
        selectedOllamaProfile = fallback.id;
      }
    } catch {
      // non-critical
    }
  }

  function initProviderState(): void {
    const state: Record<string, ProviderState> = {};
    for (const p of PROVIDERS) {
      state[p.id] = {
        selected: false, verified: false, verifying: false, error: false,
        apiKey: '', baseUrl: p.baseUrl ?? '', models: [], ollamaMode: null,
      };
    }
    providerState = state;
  }

  // ── Validation ────────────────────────────────────────────────────────────

  function validateStep0(): boolean {
    // Password is always generated on mount — this is just a safety check.
    if (uiLoginPassword.trim().length < 8) {
      step0Error = 'UI login password must be at least 8 characters.';
      return false;
    }
    step0Error = '';
    return true;
  }

  function enableRecommendedOllama(variant?: 'cuda' | 'rocm' | 'cpu'): void {
    ollamaEnabled = true;
    const st = providerState['ollama'];
    if (st) {
      st.selected = true;
      st.verified = true;
      st.ollamaMode = 'instack';
      st.baseUrl = 'http://ollama:11434';
      // Seed only the chat model, using the client-safe default constant (the
      // same default the rest of the system pulls) instead of a divergent
      // hardcode. akm self-embeds locally, so the wizard must NOT configure
      // embeddings by default (no nomic-embed-text seed).
      if (st.models.length === 0) st.models = [OLLAMA_DEFAULT_CHAT_MODEL];
    }
    // Prefer the recommended hardware variant (from the GPU-aware
    // recommendation); otherwise fall back to the ad-hoc GPU-detection guess.
    selectedOllamaProfile = selectAddonProfileId(ollamaProfiles, 'ollama', gpuDetected, variant)
      ?? addonProfileId('ollama', variant ?? (gpuDetected ? 'cuda' : 'cpu'));
  }

  // True once the recommendation fetch (display-only) has settled, regardless of
  // outcome — drives the Welcome step's "Checking your system…" neutral state.
  let recommendationFetched = $state(false);

  // Fetch the GPU/provider-aware setup recommendation for DISPLAY only (no apply).
  // Called as soon as Get Started is shown so the operator can see what was
  // detected before committing. Caches into `recommendation` so the later
  // apply path reuses it instead of re-fetching. Non-critical — on any failure
  // we leave `recommendation` null and the Welcome step falls back to generic copy.
  async function fetchRecommendation(): Promise<void> {
    if (recommendationFetched || recommendation) return;
    try {
      const res = await fetch('/api/setup/recommend');
      if (res.ok) {
        const data = await res.json() as { ok?: boolean; recommendation?: SetupRecommendation; hostProviders?: { provider: string; url: string }[] };
        if (data.ok && data.recommendation) recommendation = data.recommendation;
        if (data.ok && Array.isArray(data.hostProviders)) detectedHostProviders = data.hostProviders;
      }
    } catch {
      // non-critical — user can configure manually
    } finally {
      recommendationFetched = true;
    }
  }

  // Fetch the GPU/provider-aware setup recommendation once and apply it.
  // Supersedes the ad-hoc `gpuDetected ? 'cuda' : 'cpu'` guesses for the
  // Ollama path. Safe to call multiple times — applies only once. Reuses a
  // recommendation already fetched for display (fetchRecommendation()).
  async function fetchAndApplyRecommendation(): Promise<void> {
    if (recommendationApplied) return;
    let rec: SetupRecommendation;
    if (recommendation) {
      rec = recommendation;
    } else {
      try {
        const res = await fetch('/api/setup/recommend');
        if (!res.ok) return;
        const data = await res.json() as { ok?: boolean; recommendation?: SetupRecommendation };
        if (!data.ok || !data.recommendation) return;
        rec = data.recommendation;
      } catch {
        return; // non-critical — user can configure manually
      }
    }
    recommendationApplied = true;
    recommendation = rec;

    switch (rec.action) {
      case 'use-cloud':
        // A cloud provider is already connected — nothing to auto-do. The
        // connected providers flow through the existing detection path.
        recommendationAlert = '';
        break;
      case 'use-host-providers': {
        recommendationAlert = rec.alert;
        // Import host ollama/lmstudio so they become real providers, then
        // continue model detection via the existing host-import path.
        if (!hostImportTriggered) {
          hostImportTriggered = true;
          await handleHostImport();
        }
        break;
      }
      case 'enable-ollama':
        recommendationAlert = rec.alert;
        enableRecommendedOllama(rec.profileVariant);
        break;
      case 'connect-manually':
        // Do NOT enable Ollama and do NOT silently allow an empty install.
        // Keep the user on the Providers step with the alert visible so they
        // can sign in or add a custom OpenAI-compatible endpoint + key.
        recommendationAlert = rec.alert;
        break;
    }
  }

  async function handleUseDefaults(): Promise<void> {
    if (verifiedProviders.length >= 1) {
      // Fast path: providers already verified by background detection (cloud or
      // host). Don't force in-stack Ollama — those providers cover the assistant.
      applyImportedModelPreferences();
      autoSelectModels();
      // The fast-path skips the Models step, so the LLM-required gate
      // (validateStep2) never runs there. Validate it HERE instead so the
      // recommended path can't reach install with no validated chat model.
      // If auto-selection couldn't pick one, route the user through Models.
      if (!modelSelection.llm?.model && !allowEmptyInstall) {
        goToStep(3);
        return;
      }
      goToStep(5);
      return;
    }

    // No verified provider yet — consult the GPU/provider-aware recommendation
    // to decide what "defaults" means.
    autoModeImporting = true;
    await fetchAndApplyRecommendation();
    autoModeImporting = false;

    if (recommendation?.action === 'connect-manually') {
      // No provider and no capable GPU — refuse to silently install empty.
      // Send the user to the Providers step with the alert visible.
      goToStep(2);
      return;
    }

    // use-host-providers (handled by fetchAndApplyRecommendation -> handleHostImport,
    // which already imports + advances) and enable-ollama both leave us with a
    // usable provider. use-cloud is unreachable here (verifiedProviders === 0).
    applyImportedModelPreferences();
    autoSelectModels();
    // Same LLM gate as the fast path: never skip to Options with no chat model.
    if (!modelSelection.llm?.model && !allowEmptyInstall) {
      goToStep(3);
      return;
    }
    goToStep(5);
  }

  function handleEnableVoiceChange(v: boolean): void {
    // enableVoice is derived from the engines below — toggling drives the
    // engines, and the derived follows.
    if (v) {
      // Toggle ON → make the Voice step concretely reflect OpenPalm Voice on
      // both sides (unless they already target it).
      if (voiceTts.engine !== 'openpalm-voice') voiceTts = { engine: 'openpalm-voice' };
      if (voiceStt.engine !== 'openpalm-voice') voiceStt = { engine: 'openpalm-voice' };
      if (!selectedVoiceProfile) {
        const match = selectAddonProfileId(voiceProfiles, 'voice', gpuDetected);
        if (match) selectedVoiceProfile = match;
      }
    } else {
      // Toggle OFF → clear any OpenPalm Voice engine back to "not chosen" so the
      // Voice step no longer shows it (and addons.voice in the payload drops).
      if (voiceTts.engine === 'openpalm-voice') voiceTts = { engine: '' };
      if (voiceStt.engine === 'openpalm-voice') voiceStt = { engine: '' };
    }
  }

  function handleOptionsOllamaChange(v: boolean): void {
    // User took explicit control — never auto-sync over this choice afterward.
    ollamaEnabledInitialized = true;
    if (v) {
      enableRecommendedOllama();
    } else {
      ollamaEnabled = false;
      const st = providerState['ollama'];
      if (st && st.ollamaMode !== 'running') {
        st.selected = false;
        st.verified = false;
      }
    }
  }

  function validateStep2(): boolean {
    // Single rule, identical to canComplete: either a verified provider with a
    // chosen chat model, or an explicit empty-install opt-in. Empty-install is
    // chosen on the Providers step; if it's set we never block here.
    if (allowEmptyInstall) { step2Error = ''; return true; }
    if (verifiedProviders.length === 0) {
      step2Error = 'Connect a provider on the previous step to continue.';
      return false;
    }
    if (!modelSelection.llm?.model) {
      step2Error = 'Select a chat model to continue.';
      return false;
    }
    step2Error = '';
    return true;
  }

  function validateStep4(): boolean {
    const errors: string[] = [];
    for (const ch of CHANNELS) {
      if (!ch.credentials) continue;
      const sel = channelSelection[ch.id];
      if (typeof sel !== 'object' || sel === null) continue;
      if (!sel.enabled) continue;
      for (const cred of ch.credentials) {
        if (cred.required && !String(sel[cred.key] ?? '').trim()) {
          errors.push(ch.name + ': ' + cred.label + ' is required.');
        }
      }
    }
    if (errors.length > 0) {
      step4Error = errors.join(' ');
      return false;
    }
    step4Error = '';
    return true;
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  function canNavigateTo(step: number): boolean {
    if (step > maxVisitedStep) return false;
    return true;
  }

  function goToStep(n: number): void {
    if (n < 0 || n > 6) return;
    // Block forward navigation past System Check until it has passed.
    // Allow backwards navigation freely so users can revisit the check.
    if (n > 0 && !systemCheckPassed) return;
    currentStep = n;
    if (n > maxVisitedStep) maxVisitedStep = n;
    showDeploy = false;
    // On Get Started (index 1), fetch the recommendation for DISPLAY only so the
    // operator sees what was detected + what "Use recommended defaults" will do
    // before committing. No apply happens here. Skip on rerun — the user picks
    // where to start and an install already exists.
    if (n === 1 && !isRerun) {
      void fetchRecommendation();
    }
    // Auto-select model defaults when entering Models step (index 3)
    if (n === 3) {
      applyImportedModelPreferences();
      autoSelectModels();
    }
    // Sync ollamaEnabled from ollamaMode the FIRST time the Options step is
    // entered. The init guard stops a back/forward navigation (or a rerun where
    // ollamaEnabled was restored from config) from being overwritten by stale
    // detection state.
    if (n === 5 && hasOllamaVerified && !ollamaEnabledInitialized) {
      ollamaEnabled = providerState.ollama?.ollamaMode === 'instack';
      ollamaEnabledInitialized = true;
    }
    // On first Providers visit (index 2), apply the GPU/provider-aware
    // recommendation. It supersedes the old ad-hoc host-import trigger:
    //  - use-host-providers imports host providers + advances to Models
    //  - enable-ollama enables in-stack Ollama
    //  - connect-manually keeps the user here with the alert visible
    // On rerun we don't auto-apply — the user picks where to start.
    if (n === 2 && !isRerun) {
      void fetchAndApplyRecommendation();
    }
  }

  function autoSelectModels(): void {
    const roles = ['llm', 'embedding', 'small'] as const;
    for (const roleId of roles) {
      if (modelSelection[roleId]) continue;
      // Embedding is never auto-selected — akm self-embeds locally, so the
      // wizard leaves modelSelection.embedding unset unless a user explicitly
      // picks one in the advanced Models step.
      if (roleId === 'embedding') continue;
      const options = getModelOptionsForRole(roleId);
      if (options.length === 0) continue;
      // options are returned best-first (host/cloud > local, declared default,
      // then role score), so options[0] is the sensible pick. This is what
      // stops "first Ollama tag" (which could be an embedding model) from
      // becoming the chat model, and lets an imported host provider win.
      const best = options[0];
      modelSelection[roleId] = { connId: best.connId, model: best.id, dims: best.dims };
    }
  }

  // Shared, ranked, embedding-filtered option builder (wizard/helpers.ts) — the
  // SAME implementation the Models step uses, so auto-select and the dropdown
  // can never disagree.
  function getModelOptionsForRole(roleId: 'llm' | 'embedding' | 'small'): Array<{ id: string; connId: string; isDefault: boolean; dims: number }> {
    return buildModelOptions(roleId, verifiedProviders, providerState);
  }

  function resolvePreferredModelSelection(
    roleId: 'llm' | 'small',
    preferredModel: string | undefined,
  ): { connId: string; model: string; dims: number } | undefined {
    if (!preferredModel) return undefined;

    const slashIdx = preferredModel.indexOf('/');
    const providerHint = slashIdx > 0 ? preferredModel.slice(0, slashIdx) : '';
    const modelIdPart = slashIdx > 0 ? preferredModel.slice(slashIdx + 1) : preferredModel;

    const options = getModelOptionsForRole(roleId);

    // Exact match on full id (e.g. "openai/gpt-4o")
    const exactFull = options.find((o) => o.id === preferredModel);
    if (exactFull) return { connId: exactFull.connId, model: exactFull.id, dims: exactFull.dims };

    // Match by provider hint + model name part (e.g. "github-copilot" + "gpt-5.4")
    const providerMatch = providerHint
      ? options.find((o) => o.connId === providerHint && o.id === modelIdPart)
      : undefined;
    if (providerMatch) return { connId: providerMatch.connId, model: providerMatch.id, dims: providerMatch.dims };

    // Match by model name part alone
    const nameMatch = options.find((o) => o.id === modelIdPart);
    if (nameMatch) return { connId: nameMatch.connId, model: nameMatch.id, dims: nameMatch.dims };

    // Offline fallback (#5): the host preference names a provider that IS
    // verified, but its model list hasn't loaded (OpenCode unreachable during
    // setup, so providerState[provider].models is empty). Trust the host
    // preference directly rather than silently dropping it and letting Ollama
    // win — the model id is exactly what the host had configured.
    if (providerHint && verifiedProviders.some((p) => p.id === providerHint)) {
      return { connId: providerHint, model: modelIdPart, dims: 0 };
    }

    return undefined;
  }

  function applyImportedOpenCodeModelSelections(selectedModels?: { llm?: string; small?: string }): void {
    if (!selectedModels) return;

    // Store for re-application after autoSelectModels
    if (selectedModels.llm) importedLlmModel = selectedModels.llm;
    if (selectedModels.small) importedSmallModel = selectedModels.small;

    applyImportedModelPreferences();
  }

  function applyImportedModelPreferences(): void {
    if (importedLlmModel) {
      const llmSelection = resolvePreferredModelSelection('llm', importedLlmModel);
      if (llmSelection) modelSelection.llm = llmSelection;
    }

    if (importedSmallModel) {
      const smallSelection = resolvePreferredModelSelection('small', importedSmallModel);
      if (smallSelection) modelSelection.small = smallSelection;
    }
  }

  // ── Provider API calls ────────────────────────────────────────────────────

  async function checkOpenCodeAndInit(): Promise<void> {
    try {
      // Ensure OpenCode is running — starts a dedicated instance if not already up
      const ensureRes = await fetch('/api/setup/opencode/ensure', { method: 'POST' });
      if (ensureRes.ok) {
        const { ok } = (await ensureRes.json()) as { ok: boolean };
        if (ok) {
          opencodeAvailable = true;
          await loadOpenCodeProviders();
          return;
        }
      }
    } catch {
      // fall through to status check
    }
    // Fallback: check if OpenCode is reachable at the configured URL
    try {
      const res = await fetch('/api/setup/opencode/status');
      if (res.ok) {
        const data = await res.json();
        if (data.available) {
          opencodeAvailable = true;
          await loadOpenCodeProviders();
        }
      }
    } catch {
      // fall back to hardcoded providers
    }
  }

  async function loadOpenCodeProviders(): Promise<void> {
    const res = await fetch('/api/setup/opencode/providers');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.available || !Array.isArray(data.providers)) return;

    const providers: OpenCodeProvider[] = data.providers;
    const auth: Record<string, AuthMethod[]> = data.auth ?? {};
    // Providers that are either env-var detected OR have credentials in auth.json
    const connected = new Set<string>(Array.isArray(data.connected) ? data.connected : []);

    // Ensure local providers are in the list
    const existingIds = new Set(providers.map((p: OpenCodeProvider) => p.id));
    for (const lp of LOCAL_PROVIDERS) {
      if (!existingIds.has(lp.id)) providers.push(lp);
    }

    opencodeProviders = providers;
    opencodeAuth = auth;

    // Initialize providerState for each OpenCode provider
    const newState = { ...providerState };
    for (const ocp of providers) {
      if (!newState[ocp.id]) {
        newState[ocp.id] = {
          selected: false, verified: false, verifying: false, error: false,
          apiKey: '', baseUrl: ocp.localUrl ?? '', models: [], ollamaMode: null,
        };
      }
      const modelIds = Object.keys(ocp.models ?? {});
      if (modelIds.length > 0 && newState[ocp.id].models.length === 0) {
        newState[ocp.id].models = modelIds;
      }
      // Mark providers that are actually authenticated (env or auth.json credentials)
      if (connected.has(ocp.id)) {
        newState[ocp.id].verified = true;
      }
    }
    providerState = newState;

    applyImportedOpenCodeModelSelections(data.selectedModels as { llm?: string; small?: string } | undefined);
  }

  async function detectProviders(): Promise<void> {
    detecting = true;
    try {
      const res = await fetch('/api/setup/detect-providers');
      if (res.ok) {
        const data = await res.json();
        detectedProviders = data.providers ?? [];
        for (const dp of detectedProviders) {
          if (!dp.available) continue;
          const st = providerState[dp.provider];
          if (st) {
            st.baseUrl = dp.url;
            if (!st.selected) {
              st.selected = true;
              if (dp.provider === 'ollama') st.ollamaMode = 'running';
            }
            // Always auto-verify detected local providers regardless of whether
            // OpenCode is available — "Mark as ready" doesn't test connectivity
            void verifyProvider(dp.provider);
          }
        }
      }
    } catch {
      detectedProviders = [];
    }
    detecting = false;
  }

  async function apiFetchModels(provider: string, baseUrl: string, apiKey: string): Promise<{ models: string[] }> {
    const url = '/api/setup/models/' + encodeURIComponent(provider);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: apiKey ?? '', baseUrl: baseUrl ?? '' }),
    });
    const data = await res.json();
    if (!res.ok || data.status === 'recoverable_error') {
      throw new Error(data.error ?? ('Failed to fetch models (HTTP ' + res.status + ')'));
    }
    return data;
  }

  async function verifyProvider(id: string): Promise<void> {
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) return;
    const st = providerState[id];
    if (!st) return;

    // For ollama instack mode, just mark verified
    if (id === 'ollama' && st.ollamaMode === 'instack') {
      st.verified = true;
      st.error = false;
      return;
    }

    const gen = (verifyGeneration[id] ?? 0) + 1;
    verifyGeneration[id] = gen;

    st.verifying = true;
    st.error = false;

    const baseUrl = (st.baseUrl || p.baseUrl).trim();
    const apiKey = (st.apiKey ?? '').trim();

    try {
      const result = await apiFetchModels(id, baseUrl, apiKey);
      if (verifyGeneration[id] !== gen) return;
      st.verified = true;
      st.error = false;
      st.models = result.models ?? [];
    } catch (e) {
      if (verifyGeneration[id] !== gen) return;
      st.verified = false;
      st.error = true;
      st.errorMessage = e instanceof Error ? e.message : '';
      st.models = [];
    }

    st.verifying = false;
  }

  // ── OpenCode auth ─────────────────────────────────────────────────────────

  async function connectOpenCodeApiKey(providerId: string): Promise<void> {
    const st = providerState[providerId];
    if (!st?.apiKey) return;

    st.verifying = true;
    st.error = false;

    try {
      const res = await fetch('/api/setup/opencode/auth/' + encodeURIComponent(providerId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'api', key: st.apiKey }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? ('Failed to connect (HTTP ' + res.status + ')'));
      }
      st.verified = true;
      st.error = false;
    } catch (e) {
      st.verified = false;
      st.error = true;
      st.errorMessage = e instanceof Error ? e.message : 'Connection failed';
    }

    st.verifying = false;
  }

  async function startOpenCodeOAuth(providerId: string, methodIndex: number): Promise<void> {
    const st = providerState[providerId];
    if (!st) return;

    st.verifying = true;
    st.error = false;

    try {
      const res = await fetch('/api/setup/opencode/provider/' + encodeURIComponent(providerId) + '/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: methodIndex }),
      });
      const oauthRes = await res.json() as OAuthAuthorizeResponse;
      if (!res.ok) throw new Error(oauthRes.message ?? 'OAuth failed');

      st.oauthPolling = true;
      st.oauthUrl = oauthRes.url ?? '';
      st.oauthInstructions = oauthRes.instructions ?? '';

      if (oauthRes.url && oauthRes.method === 'auto') {
        window.open(oauthRes.url, '_blank');
      }

      await pollOpenCodeOAuth(providerId, methodIndex);
    } catch (e) {
      st.verifying = false;
      st.error = true;
      st.errorMessage = e instanceof Error ? e.message : 'OAuth failed';
      st.oauthPolling = false;
    }
  }

  async function pollOpenCodeOAuth(providerId: string, methodIndex: number): Promise<void> {
    const st = providerState[providerId];
    const ac = new AbortController();
    oauthAbortControllers[providerId] = ac;

    // Combine user-cancellation AbortController with a 10-minute timeout
    const timeoutSignal = AbortSignal.timeout(10 * 60_000);
    const combinedSignal = AbortSignal.any
      ? AbortSignal.any([ac.signal, timeoutSignal])
      : ac.signal;

    try {
      // The callback is a long-poll — make one call and wait (up to 10 minutes)
      const res = await fetch('/api/setup/opencode/provider/' + encodeURIComponent(providerId) + '/oauth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: methodIndex }),
        signal: combinedSignal,
      });
      const data = await res.json().catch(() => null);
      if (res.ok && (data as { ok?: boolean })?.ok) {
        st.verified = true;
        st.error = false;
      } else {
        st.error = true;
        st.errorMessage = (data as { message?: string })?.message ?? 'Authorization failed';
      }
    } catch (e) {
      // AbortError from user cancel — don't show an error
      if (e instanceof Error && e.name === 'AbortError' && ac.signal.aborted) return;
      // Timeout case
      if (e instanceof Error && e.name === 'AbortError') {
        st.error = true;
        st.errorMessage = 'Authorization timed out. Try again.';
      } else {
        st.error = true;
        st.errorMessage = e instanceof Error ? e.message : 'Authorization failed';
      }
    } finally {
      delete oauthAbortControllers[providerId];
      st.oauthPolling = false;
      st.verifying = false;
    }
  }

  // ── Install & deploy ──────────────────────────────────────────────────────

  async function handleInstall(): Promise<void> {
    if (installing) return;
    installError = '';

    // Single "no AI configured" confirmation. When the payload has no `llm`,
    // require one explicit acknowledgment before installing — this replaces the
    // scattered soft warnings on Providers/Models/Review. Rerun keeps existing
    // config, so don't re-prompt there.
    const payloadHasLlm = !!(payload as { llm?: unknown }).llm;
    if (!payloadHasLlm && !isRerun && !emptyAiAck) {
      const ok = window.confirm(
        'No AI provider is configured. Your assistant won’t be able to chat until you add one from the dashboard.\n\nInstall anyway?',
      );
      if (!ok) return;
      emptyAiAck = true;
    }

    installing = true;

    // Ensure a voice profile is selected when voice is enabled.
    // loadVoiceProfiles() is async and may not have resolved yet.
    const usesBundledVoice = persistedVoiceTts.engine === 'openpalm-voice' || persistedVoiceStt.engine === 'openpalm-voice';
    if (usesBundledVoice && !selectedVoiceProfile) {
      selectedVoiceProfile = selectAddonProfileId(voiceProfiles, 'voice', gpuDetected)
        ?? addonProfileId('voice', 'cpu');
    }

    // Ensure an Ollama profile is selected when Ollama is enabled in-stack.
    if (ollamaEnabled && !selectedOllamaProfile) {
      selectedOllamaProfile = addonProfileId('ollama', gpuDetected ? 'cuda' : 'cpu');
    }

    try {
      const res = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        // Docker-down (HTTP 503 { error:'docker_unavailable', message }) and any
        // other failure: surface the human-readable message and STOP. Do not
        // flip into showDeploy / the polling "Preparing…" spinner — there's no
        // deploy to poll, so doing so would hang forever.
        installError = data.message ?? data.error ?? 'Install failed.';
        installing = false;
        showDeploy = false;
        return;
      }

      showDeploy = true;
      startDeployPolling();
    } catch (e) {
      installError = 'Network error: ' + (e instanceof Error ? e.message : 'unable to reach server.');
      installing = false;
    }
  }

  function startDeployPolling(): void {
    stopDeployPolling();
    void pollDeployStatus();
    deployTimer = setInterval(() => { void pollDeployStatus(); }, 2500);
  }

  function stopDeployPolling(): void {
    if (deployTimer) { clearInterval(deployTimer); deployTimer = null; }
  }

  async function pollDeployStatus(): Promise<void> {
    try {
      const res = await fetch('/api/setup/deploy-status');
      if (!res.ok) {
        deployPollErrors++;
        if (deployPollErrors >= 5) {
          // Lost contact with the installer — surface a real error instead of
          // pretending the deploy succeeded. Previous behaviour silently marked
          // all services "running" after 3 failed polls, which hid real problems.
          stopDeployPolling();
          deployError = 'Lost contact with the installer. Services may still be starting in the background.';
        }
        return;
      }
      const data = await res.json();
      deployPollErrors = 0;

      if (data.deployStatus && data.deployStatus.length > 0) {
        lastDeployData = data.deployStatus.map((s: { service: string; status: string; label?: string }) => ({
          service: s.service, status: s.status, label: s.label,
        }));
      }

      deployData = data;

      if (data.deployError) {
        stopDeployPolling();
        deployError = data.deployError;
      } else if (data.setupComplete && data.deployStatus && data.deployStatus.length > 0) {
        const rows = data.deployStatus as { status: string }[];
        const allRunning = rows.every((s) => s.status === 'running');
        // Treat "warning" (e.g. voice still warming) as a NON-blocking terminal
        // status. Once setup is complete and not deploying, any remaining
        // non-running rows that are ALL warnings mean we're done — with
        // warnings. Otherwise (non-running, non-warning rows) keep polling.
        const onlyWarningsLeft = !data.deploying
          && rows.every((s) => s.status === 'running' || s.status === 'warning')
          && rows.some((s) => s.status === 'warning');
        if (allRunning) {
          stopDeployPolling();
          deployDone = true;
        } else if (onlyWarningsLeft) {
          stopDeployPolling();
          deployHasWarnings = true;
          deployDone = true;
        }
      } else if (data.setupComplete && !data.deploying && (!data.deployStatus || data.deployStatus.length === 0)) {
        stopDeployPolling();
        deployDone = true;
      }
    } catch (err) {
      deployPollErrors++;
      if (deployPollErrors >= 5) {
        stopDeployPolling();
        deployError = err instanceof Error
          ? `Lost contact with the installer: ${err.message}`
          : 'Lost contact with the installer.';
      }
    }
  }

  // ── Event handlers for child components ──────────────────────────────────

  function handleToggleFallback(id: string): void {
    const st = providerState[id];
    if (!st) return;
    if (st.selected) {
      expandedProvider = expandedProvider === id ? null : id;
    } else {
      st.selected = true;
      expandedProvider = id;
      const detected = detectedProviders.find((d) => d.provider === id && d.available);
      if (detected) st.baseUrl = detected.url;
    }
  }

  function handleToggleOpenCode(id: string): void {
    expandedProvider = expandedProvider === id ? null : id;
  }

  function handleDeselect(id: string): void {
    const st = providerState[id];
    if (!st) return;
    st.selected = false;
    st.verified = false;
    st.verifying = false;
    st.error = false;
    st.apiKey = '';
    st.models = [];
    if (id === 'ollama') st.ollamaMode = null;
    if (expandedProvider === id) expandedProvider = null;
  }

  function handleMarkReady(id: string): void {
    const st = providerState[id];
    if (st) { st.verified = true; st.error = false; }
  }

  function handleVerify(id: string): void {
    if (opencodeAvailable) {
      const st = providerState[id];
      // Local/keyless providers: register empty key then fetch models to verify connectivity
      if (st && !st.apiKey) {
        void verifyProvider(id);
      } else {
        void connectOpenCodeApiKey(id);
      }
    } else {
      void verifyProvider(id);
    }
  }

  function handleApiKey(id: string, key: string): void {
    const st = providerState[id];
    if (st) st.apiKey = key;
  }

  function handleBaseUrl(id: string, url: string): void {
    const st = providerState[id];
    if (st) st.baseUrl = url;
  }

  function handleOllamaMode(mode: 'running' | 'instack'): void {
    const st = providerState.ollama;
    if (st) st.ollamaMode = mode;
  }

  function handleChannelToggle(id: string): void {
    const sel = channelSelection[id];
    if (typeof sel === 'object' && sel !== null) {
      sel.enabled = !sel.enabled;
    } else {
      channelSelection[id] = !sel;
    }
  }

  function handleCredentialChange(chId: string, credKey: string, value: string): void {
    const sel = channelSelection[chId];
    if (typeof sel === 'object' && sel !== null) {
      sel[credKey] = value;
    }
  }

  function handleSelectModel(role: string, connId: string, modelId: string, dims: number): void {
    modelSelection[role as 'llm' | 'embedding' | 'small'] = { connId, model: modelId, dims };
    if (role === 'embedding' && (dims <= 0 || dims === undefined)) {
      step2EmbDimWarning = 'Unknown embedding model dimensions — set manually in akm config after install.';
    } else if (role === 'embedding') {
      step2EmbDimWarning = '';
    }
  }

  function handleSelectNone(role: string): void {
    delete modelSelection[role as 'llm' | 'embedding' | 'small'];
  }

  function handleDeployRetry(): void {
    installing = false;
    deployError = null;
    deployDone = false;
    deployHasWarnings = false;
    deployData = {};
    lastDeployData = null;
    deployPollErrors = 0;
    void handleInstall();
  }

  function handleDeployBack(): void {
    installing = false;
    deployError = null;
    deployDone = false;
    deployHasWarnings = false;
    deployData = {};
    deployPollErrors = 0;
    lastDeployData = null;
    showDeploy = false;
    // Return to Review step (index 6)
    currentStep = 6;
  }

  // ── Host import ───────────────────────────────────────────────────────────

  let hostImportTriggered = $state(false);
  let hostImporting = $state(false);

  async function loadHostStatus(): Promise<void> {
    try {
      // Use setup-namespace endpoint — no admin auth needed during setup
      const res = await fetch('/api/setup/host-status');
      if (res.ok) {
        const data = (await res.json()) as { providerCount: number; credentialCount?: number; modelPreferences?: { model?: string; small_model?: string }; imageTag?: string; hostAkmAvailable?: boolean; warning?: string };
        hostProviderCount = Math.max(data.providerCount ?? 0, data.credentialCount ?? 0);
        if (data.imageTag && !imageTag) imageTag = data.imageTag;
        if (typeof data.hostAkmAvailable === 'boolean') hostAkmAvailable = data.hostAkmAvailable;
        hostStatusWarning = data.warning ?? null;
        // Eagerly store host model preferences so applyImportedModelPreferences()
        // works even on the fast path (providers already verified, no import needed).
        if (data.modelPreferences?.model) importedLlmModel = data.modelPreferences.model;
        if (data.modelPreferences?.small_model) importedSmallModel = data.modelPreferences.small_model;
        // Auto-import if already on Providers step (index 2), or always on rerun
        // so models/settings have verified providers to attach to.
        if (hostProviderCount > 0 && !hostImportTriggered && (currentStep === 2 || isRerun)) {
          hostImportTriggered = true;
          void handleHostImport();
        }
      }
    } catch {
      // non-critical
    }
  }

  function markProviderVerifiedFromImport(id: string): void {
    let st = providerState[id];
    if (!st) {
      // OpenCode provider not yet in state (e.g. OpenCode unreachable during
      // setup so loadOpenCodeProviders didn't run) — seed a minimal verified
      // entry so the imported provider still counts toward verifiedProviders.
      st = {
        selected: true, verified: true, verifying: false, error: false,
        apiKey: '', baseUrl: '', models: [], ollamaMode: null,
      };
      providerState[id] = st;
      return;
    }
    st.verified = true;
    st.error = false;
  }

  async function handleHostImport(): Promise<void> {
    hostImporting = true;
    hostStatusWarning = null;
    try {
      // Use setup-namespace endpoint — no admin auth needed during setup
      const res = await fetch('/api/setup/import-host', { method: 'POST' });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        importedProviders?: string[];
        pushedProviders?: string[];
      } | null;

      if (!res.ok || !data?.ok) {
        // Hard failure (could not copy host config). Keep the user on the
        // Providers step with a clear message instead of silently doing nothing.
        hostImporting = false;
        hostStatusWarning = data?.error
          ? `Couldn't import host providers: ${data.error}`
          : "Couldn't import providers from host OpenCode. Configure providers manually below.";
        return;
      }

      // Mark every imported provider verified directly from the response. This
      // does NOT depend on OpenCode being reachable: the credentials are on
      // disk and provider-consuming services read them on start. A live push
      // failure only delays the "connected" indicator, it isn't an import
      // failure.
      const importedIds = data.importedProviders ?? data.pushedProviders ?? [];
      for (const id of importedIds) markProviderVerifiedFromImport(id);

      // Reload providers when OpenCode is reachable so the full catalog +
      // env-detected credentials are reflected. Non-fatal if it can't run.
      if (opencodeAvailable) {
        try { await loadOpenCodeProviders(); } catch { /* keep import-marked verified state */ }
      }

      // First pass: apply imported model preferences from whatever models are
      // already loaded (host provider may already be populated by the reload).
      applyImportedModelPreferences();

      // Verify local providers to fetch live models. AWAIT them so the host
      // model preference (and host-over-Ollama precedence) is resolved against
      // a fully-populated model list — applying before the lists loaded was the
      // race that silently dropped the host preference (#4). Per-provider
      // failures are non-fatal.
      await Promise.allSettled(
        Object.keys(providerState)
          .filter((id) => !providerState[id].verified && PROVIDERS.some((p) => p.id === id))
          .map((id) => verifyProvider(id)),
      );

      // Second pass: now that model lists are populated, re-apply the host
      // preference (it overrides any earlier Ollama auto-pick) and fill any
      // still-unset roles with the ranked default (host/cloud before Ollama).
      applyImportedModelPreferences();
      autoSelectModels();

      hostImporting = false;
      // After host import, advance to Models step (index 3). Skip the
      // auto-advance on rerun — the user picks where to start.
      if (!isRerun) goToStep(3);
    } catch (e) {
      hostImporting = false;
      hostStatusWarning = `Couldn't import providers from host OpenCode: ${e instanceof Error ? e.message : 'network error'}. Configure providers manually below.`;
    }
  }

  let isRerun = $state(false);

  // ── Mount: generate token, check status, start discovery ─────────────────
  onMount(() => {
    initProviderState();

    const params = new URLSearchParams(window.location.search);
    isRerun = params.get('rerun') === '1';

    if (isRerun) {
      // Rerun mode: the install is already working, so unlock navigation
      // immediately and pre-fill every step from current config.
      systemCheckPassed = true;
      maxVisitedStep = 6;
      uiLoginPassword = generatePassword(); // fallback; replaced if API returns existing

      fetch('/api/setup/current-config')
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (!data) return;
          // S3: current-config no longer returns the plaintext password.
          // On rerun the wizard keeps the generated password unless the user
          // edits it — hasPassword just confirms a password is already set.
          //
          // Do NOT pre-fill the image-tag field from the existing OP_IMAGE_TAG.
          // Doing so made a stale pin sticky: a re-run over an OP_HOME pinned to
          // an old version (e.g. v0.11.1) re-submitted that tag as if it were a
          // deliberate choice, so performSetup kept deploying the old image
          // instead of resetting to `latest`. Leaving the field blank lets the
          // reconcile default to `latest`; a power user can still re-pin in the
          // Advanced field.
          if (typeof data.hostAkm === 'boolean') hostAkmEnabled = data.hostAkm;

          // Models — store saved selections; the connId resolves once the
          // matching provider is verified by the host-import / OpenCode flow.
          if (data.llm?.provider && data.llm?.model) {
            modelSelection.llm = { connId: data.llm.provider, model: data.llm.model };
          }
          if (data.embedding?.provider && data.embedding?.model) {
            modelSelection.embedding = {
              connId: data.embedding.provider,
              model: data.embedding.model,
              dims: data.embedding.dims,
            };
          }

          // Voice — pre-fill connection fields only when the stored
          // config explicitly names the engine. No URL sniffing.
          if (data.voice?.tts) {
            const storedTts = data.voice.tts as { baseURL?: string; model?: string; voice?: string; engine?: string };
            if (storedTts.engine) {
              voiceTts = { ...storedTts, engine: storedTts.engine };
            } else {
              voiceTts = { engine: '' };
              voiceEngineUnknownTts = true;
            }
          }
          if (data.voice?.stt) {
            const storedStt = data.voice.stt as { baseURL?: string; model?: string; voice?: string; language?: string; engine?: string };
            if (storedStt.engine) {
              voiceStt = { ...storedStt, engine: storedStt.engine };
            } else {
              voiceStt = { engine: '' };
              voiceEngineUnknownStt = true;
            }
          }

          if (data.voice?.selectedProfile && typeof data.voice.selectedProfile === 'string') {
            selectedVoiceProfile = data.voice.selectedProfile;
          }

          // Restore host-imported model preferences so a rerun keeps the chat /
          // small model the user configured on their host OpenCode (otherwise
          // they had to re-import or re-pick). importedModelPreferences is added
          // by /api/setup/current-config; applyImportedModelPreferences() runs
          // when the Models step is entered (and after host import).
          const imp = data.importedModelPreferences as { model?: string; small_model?: string } | null | undefined;
          if (imp?.model) importedLlmModel = imp.model;
          if (imp?.small_model) importedSmallModel = imp.small_model;

          // Enabled addons + channel credentials
          const enabled: string[] = Array.isArray(data.enabledAddons) ? data.enabledAddons : [];
          if (enabled.includes('ollama')) ollamaEnabled = true;
          // The restored value is authoritative — don't let the Options-step
          // auto-sync overwrite it (#16).
          ollamaEnabledInitialized = true;
          if (data.ollama?.selectedProfile && typeof data.ollama.selectedProfile === 'string') {
            selectedOllamaProfile = data.ollama.selectedProfile;
          }
          const creds = data.channelCredentials ?? {};
          for (const chId of ['discord', 'slack']) {
            const sel = channelSelection[chId];
            if (typeof sel === 'object' && sel !== null) {
              if (enabled.includes(chId)) sel.enabled = true;
              const c = creds[chId];
              if (c && typeof c === 'object') Object.assign(sel, c);
            }
          }
        })
        .catch((e) => { console.error('[setup] failed to load existing config:', e); });
    } else {
      uiLoginPassword = generatePassword();
      fetch('/api/setup/status')
        .then((r) => r.json())
        .then((data) => { if (data.setupComplete) window.location.href = '/'; })
        .catch((e) => { console.error('[setup] failed to check setup status:', e); });
    }

    // If a previous deploy is still running (or errored), pick it up
    // without re-triggering /api/setup/complete.
    fetch('/api/setup/deploy-status')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        if (data.deploying || data.deployError) {
          deployData = data;
          showDeploy = true;
          startDeployPolling();
        }
      })
      .catch((e) => { console.error('[setup] failed to fetch deploy status:', e); });

    void loadHostStatus();
    void loadVoiceProfiles();
    void loadOllamaProfiles();

    // U3: Ensure detectionReady is set after at most 10 s so the
    // "Use recommended defaults" button is never permanently disabled.
    const detectionTimeout = setTimeout(() => { detectionReady = true; }, 10_000);

    checkOpenCodeAndInit()
      .then(() => detectProviders())
      .catch((e) => { console.error('[setup] provider detection failed:', e); })
      .finally(() => { clearTimeout(detectionTimeout); detectionReady = true; });
  });
</script>

<svelte:head>
  <title>OpenPalm Setup</title>
  <link rel="stylesheet" href="/setup/wizard.css">
</svelte:head>

<main class="setup-page" aria-label="Setup wizard">
  <div class="wizard-card">

    {#if isRerun}
      <div class="rerun-banner">
        <span>Updating existing installation</span>
        <a href="/" class="rerun-back-link">← Back to Admin</a>
      </div>
    {/if}

    <div class="wizard-header">
      <div class="hdr-logo">OP</div>
      <h1>OpenPalm <span class="hdr-suffix">{isRerun ? 'Update Settings' : 'Setup'}</span></h1>
    </div>

    <div class="wizard-body">

      {#if !showDeploy}
        <ProgressBar
          {currentStep}
          {maxVisitedStep}
          onnavigate={goToStep}
          {canNavigateTo}
        />
      {/if}

      {#if !showDeploy && recommendationAlert && (currentStep === 2 || currentStep === 3)}
        <div class="feedback feedback--warning" role="alert" data-testid="recommendation-alert"><span>{recommendationAlert}</span></div>
      {/if}

      {#if showDeploy}
        <DeployStep
          {deployData}
          {deployDone}
          {deployHasWarnings}
          {deployError}
          onback={handleDeployBack}
          onretry={handleDeployRetry}
        />
      {:else if currentStep === 0}
        <section class="step-content" id="step-0" data-testid="step-system-check">
          <SystemCheckStep
            {isRerun}
            onpass={() => { systemCheckPassed = true; }}
            onnext={() => { systemCheckPassed = true; goToStep(1); }}
            ongpudetected={(_gpu) => {
              gpuDetected = true;
              // If profiles already loaded, upgrade to CUDA now
              if (voiceProfiles.length > 0 && selectedVoiceProfile !== addonProfileId('voice', 'cuda')) {
                const cuda = voiceProfiles.find((p) => p.id === addonProfileId('voice', 'cuda') && p.available !== false);
                if (cuda) selectedVoiceProfile = cuda.id;
              }
            }}
          />
        </section>
      {:else if currentStep === 1}
        <section class="step-content" id="step-1" data-testid="step-welcome">
          <WelcomeStep
            errorMessage={step0Error}
            {detectionReady}
            {autoModeImporting}
            {recommendation}
            {recommendationFetched}
            onnext={() => { if (validateStep0()) goToStep(2); }}
            onusedefaults={() => { if (validateStep0()) void handleUseDefaults(); }}
          />
        </section>
      {:else if currentStep === 2}
        <section class="step-content" id="step-2" data-testid="step-capabilities">
          <ProvidersStep
            {hostImporting}
            {opencodeAvailable}
            {opencodeProviders}
            {opencodeAuth}
            {providerState}
            {expandedProvider}
            {detectedProviders}
            {detecting}
            {ocFilterQuery}
            {verifiedCount}
            {hostProviderCount}
            {hostStatusWarning}
            {allowEmptyInstall}
            canProceed={hasVerifiedProvider || allowEmptyInstall}
            onback={() => goToStep(1)}
            onnext={() => goToStep(3)}
            ontogglefallback={handleToggleFallback}
            ontoggleopencode={handleToggleOpenCode}
            onverify={handleVerify}
            onapikey={handleApiKey}
            onbaseurl={handleBaseUrl}
            onollamamode={handleOllamaMode}
            onoauthstart={startOpenCodeOAuth}
            onoauthcancel={(id) => {
              const ac = oauthAbortControllers[id];
              if (ac) { ac.abort(); delete oauthAbortControllers[id]; }
              const st = providerState[id];
              if (st) { st.oauthPolling = false; st.verifying = false; }
            }}
            onmarkready={handleMarkReady}
            ondeselect={handleDeselect}
            onfilterchange={(q) => ocFilterQuery = q}
            onhostimport={() => void handleHostImport()}
            onallowemptyinstallchange={(v) => allowEmptyInstall = v}
          />
        </section>
      {:else if currentStep === 3}
        <section class="step-content" id="step-3" data-testid="step-models">
          {#if step2EmbDimWarning}
            <div class="feedback feedback--warning" role="alert"><span>{step2EmbDimWarning}</span></div>
          {/if}
          <ModelsStep
            {verifiedProviders}
            {providerState}
            {modelSelection}
            {allowEmptyInstall}
            {canComplete}
            errorMessage={step2Error}
            onback={() => goToStep(2)}
            onnext={() => { if (validateStep2()) goToStep(4); }}
            onselect={handleSelectModel}
            onselectnone={handleSelectNone}
          />
        </section>
      {:else if currentStep === 4}
        <section class="step-content" id="step-4" data-testid="step-voice">
          <VoiceStep
            tts={displayedVoiceTts}
            stt={displayedVoiceStt}
            {hasOpenAI}
            unknownTts={voiceEngineUnknownTts}
            unknownStt={voiceEngineUnknownStt}
            profiles={voiceProfiles}
            {selectedVoiceProfile}
            onback={() => goToStep(3)}
            onnext={() => goToStep(5)}
            onchangetts={(v) => {
              voiceTts = v;
              voiceEngineUnknownTts = false;
              // enableVoice is derived from the engines — no manual sync needed.
            }}
            onchangestt={(v) => {
              voiceStt = v;
              voiceEngineUnknownStt = false;
            }}
            onprofilechange={(id) => { selectedVoiceProfile = id; }}
          />
        </section>
      {:else if currentStep === 5}
        <section class="step-content" id="step-5" data-testid="step-options">
          <OptionsStep
            {channelSelection}
            {imageTag}
            {hostAkmEnabled}
            {hostAkmAvailable}
            {enableVoice}
            {voiceProfiles}
            {selectedVoiceProfile}
            {ollamaEnabled}
            {ollamaProfiles}
            {selectedOllamaProfile}
            hostLocalRunning={hostLocalLlmRunning}
            errorMessage={step4Error}
            onback={() => goToStep(4)}
            onnext={() => { if (validateStep4()) goToStep(6); }}
            onchanneltoggle={handleChannelToggle}
            oncredentialchange={handleCredentialChange}
            onimagtagchange={(v) => imageTag = v}
            onhostakmchange={(v) => hostAkmEnabled = v}
            onenablevoicechange={handleEnableVoiceChange}
            onvoiceprofilechange={(id) => { selectedVoiceProfile = id; }}
            onollamachange={handleOptionsOllamaChange}
            onollamaprofilechange={(id) => { selectedOllamaProfile = id; }}
          />
        </section>
      {:else if currentStep === 6}
        <section class="step-content" id="step-6" data-testid="step-review">
          <ReviewStep
            {uiLoginPassword}
            {verifiedProviders}
            {modelSelection}
            activeTts={persistedVoiceTts.engine}
            activeStt={persistedVoiceStt.engine}
            voiceProfileLabel={selectedVoiceProfileLabel}
            ollamaProfileLabel={selectedOllamaProfileLabel}
            {channelSelection}
            {ollamaEnabled}
            {payload}
            {installError}
            {installing}
            {isRerun}
            onback={() => goToStep(5)}
            oninstall={handleInstall}
            ongostepedit={goToStep}
          />
        </section>
      {/if}

    </div>
  </div>
</main>
