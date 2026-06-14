<script lang="ts">
  import { onMount } from 'svelte';
  import {
    PROVIDERS, LOCAL_PROVIDERS, CHANNELS, OLLAMA_DEFAULT_CHAT_MODEL,
  } from '$lib/client/constants.js';
  import { buildModelOptions, selectAddonProfileId, resolveVoiceSide } from '$lib/client/helpers.js';
  import type {
    ProviderState, ModelSelection, DetectedProvider, ChannelState,
    OpenCodeProvider, AuthMethod, VoiceEngineValue,
  } from '$lib/client/types.js';
  import type { VoiceAddonProfile } from '$lib/api.js';
  import type { SetupRecommendation } from '@openpalm/lib';
  import { addonProfileId } from '@openpalm/lib/provider-constants';
  import { friendlyError, type FriendlyErrorView } from '$lib/client/error-messages.js';
  import SystemCheckStep from './steps/SystemCheckStep.svelte';
  import Screen1ModelsStep from './steps/Screen1ModelsStep.svelte';
  import Screen2ExtrasStep from './steps/Screen2ExtrasStep.svelte';
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

  // ── Model mode + explicit voice toggle (new 3-screen flow) ───────────────
  // modelMode: which high-level option the user chose on Screen 1.
  // Pre-set to 'cloud'; detection may update it before Screen 1 renders.
  type ModelMode = 'cloud' | 'local' | 'both';
  let modelMode = $state<ModelMode>('cloud');
  // voiceEnabled: explicit toggle state — OFF by default, always.
  // Separate from the `enableVoice` derived (which drives the payload).
  // Screen2ExtrasStep reads this and only sets engine values when true.
  let voiceEnabled = $state(false);

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
  // Raw detection data from /api/setup/recommend (stored separately for Screen1 props)
  let detectedGpuVramMb = $state(0);
  let detectedGpuVendor = $state('');
  let detectedGpuName = $state('');
  let detectedCloudProviders = $state<string[]>([]);
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

  // True only when a usable chat model is actually selected — drives the
  // step-1 "we found an AI" vs "pick one" copy. (verifiedCount can be >0 with
  // no usable/selected model, e.g. providers detected but no model resolved.)
  const hasUsableAI = $derived(!!modelSelection.llm?.model);

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
  // Can finish when an actual chat model is selected, OR the user explicitly
  // opted to skip AI for now. (Don't require a model just because *some*
  // provider is "connected" — it may have no usable models, which would
  // otherwise leave the user stuck with Continue disabled and no escape.)
  const canComplete = $derived(
    !!modelSelection.llm?.model || allowEmptyInstall,
  );

  // Chat-model options across all verified providers — drives the model picker
  // on the Connect step so the user can choose which model to use.
  const llmModelOptions = $derived(buildModelOptions('llm', verifiedProviders, providerState));

  const hasOpenAI = $derived(
    PROVIDERS.some((p) => p.id === 'openai' && providerState[p.id]?.verified)
  );

  const voiceDefaults = $derived(hasOpenAI
    ? { tts: 'openai-tts', stt: 'openai-stt' }
    : { tts: 'browser-tts', stt: 'browser-stt' });

  // Resolve one voice side (tts|stt): an explicit engine wins; else OpenPalm
  // Voice when the bundled voice is enabled; else the given fallback. The
  // `displayed*` derivations pass a sensible default engine (for the UI); the
  // `persisted*` ones pass '' (an empty engine means "don't save this side").
  // resolveVoiceSide is exported from helpers.ts for testability.
  const displayedVoiceTts = $derived(resolveVoiceSide(voiceTts, enableVoice, voiceDefaults.tts));
  const displayedVoiceStt = $derived(resolveVoiceSide(voiceStt, enableVoice, voiceDefaults.stt));
  const persistedVoiceTts = $derived(resolveVoiceSide(voiceTts, enableVoice, ''));
  const persistedVoiceStt = $derived(resolveVoiceSide(voiceStt, enableVoice, ''));

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
      if (v.apiKey) out.apiKey = v.apiKey;
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

  // ── Connect-step row selection: cloud ↔ local actually switches the model ──
  const LOCAL_PROVIDER_IDS = new Set(['ollama', 'lmstudio', 'llamacpp', 'localai', 'model-runner']);
  let savedCloudLlm = $state<ModelSelection | undefined>(undefined);
  // Stable "detected cloud service" connId — captured once so the cloud row stays
  // visible even after the user switches to local (lets them switch back).
  let detectedCloudConn = $state('');
  $effect(() => {
    if (!detectedCloudConn && modelSelection.llm && !LOCAL_PROVIDER_IDS.has(modelSelection.llm.connId)) {
      detectedCloudConn = modelSelection.llm.connId;
    }
  });

  function handleConnectModeChange(mode: 'cloud' | 'local' | 'both'): void {
    modelMode = mode;
    if (mode === 'local') {
      // Remember the cloud model so switching back restores it.
      if (modelSelection.llm && !LOCAL_PROVIDER_IDS.has(modelSelection.llm.connId)) {
        savedCloudLlm = modelSelection.llm;
      }
      // Use a detected host runtime if present; otherwise enable in-stack Ollama.
      if (!hostLocalLlmRunning) enableRecommendedOllama();
      // Point the chat model at the local runtime so the install + button reflect it.
      const localOpt = getModelOptionsForRole('llm').find((o) => LOCAL_PROVIDER_IDS.has(o.connId));
      modelSelection.llm = localOpt
        ? { connId: localOpt.connId, model: localOpt.id, dims: localOpt.dims }
        : { connId: 'ollama', model: OLLAMA_DEFAULT_CHAT_MODEL, dims: 0 };
    } else if (mode === 'cloud') {
      if (savedCloudLlm) modelSelection.llm = savedCloudLlm;
    }
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
        const data = await res.json() as {
          ok?: boolean;
          recommendation?: SetupRecommendation;
          hostProviders?: { provider: string; url: string }[];
          gpu?: { vramMb?: number; vendor?: string; name?: string } | null;
          cloudProviders?: string[];
        };
        if (data.ok && data.recommendation) recommendation = data.recommendation;
        if (data.ok && Array.isArray(data.hostProviders)) detectedHostProviders = data.hostProviders;
        if (data.ok && data.gpu) {
          detectedGpuVramMb = data.gpu.vramMb ?? 0;
          detectedGpuVendor = data.gpu.vendor ?? '';
          detectedGpuName = data.gpu.name ?? '';
        }
        if (data.ok && Array.isArray(data.cloudProviders)) detectedCloudProviders = data.cloudProviders;
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
        const data = await res.json() as {
          ok?: boolean;
          recommendation?: SetupRecommendation;
          hostProviders?: { provider: string; url: string }[];
          gpu?: { vramMb?: number; vendor?: string; name?: string } | null;
          cloudProviders?: string[];
        };
        if (!data.ok || !data.recommendation) return;
        rec = data.recommendation;
        if (Array.isArray(data.hostProviders)) detectedHostProviders = data.hostProviders;
        if (data.gpu) {
          detectedGpuVramMb = data.gpu.vramMb ?? 0;
          detectedGpuVendor = data.gpu.vendor ?? '';
          detectedGpuName = data.gpu.name ?? '';
        }
        if (Array.isArray(data.cloudProviders)) detectedCloudProviders = data.cloudProviders;
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

  // Apply imported prefs + auto-select, then advance to Screen 1.
  // In the new 3-screen flow everything is on Screen 1 (step 1).
  function applyDefaultsAndRoute(): void {
    applyImportedModelPreferences();
    autoSelectModels();
    goToStep(1);
  }

  async function handleUseDefaults(): Promise<void> {
    if (verifiedProviders.length >= 1) {
      // Fast path: providers already verified by background detection (cloud or
      // host). Don't force in-stack Ollama — those providers cover the assistant.
      applyDefaultsAndRoute();
      return;
    }

    // No verified provider yet — consult the GPU/provider-aware recommendation
    // to decide what "defaults" means.
    autoModeImporting = true;
    await fetchAndApplyRecommendation();
    autoModeImporting = false;

    if (recommendation?.action === 'connect-manually') {
      // No provider and no capable GPU — keep user on Screen 1 with alert.
      goToStep(1);
      return;
    }

    // use-host-providers (handled by fetchAndApplyRecommendation -> handleHostImport,
    // which already imports + advances) and enable-ollama both leave us with a
    // usable provider. use-cloud is unreachable here (verifiedProviders === 0).
    applyDefaultsAndRoute();
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
    if (n < 0 || n > 3) return;
    // Block forward navigation past System Check until it has passed.
    // Allow backwards navigation freely so users can revisit the check.
    if (n > 0 && !systemCheckPassed) return;
    currentStep = n;
    if (n > maxVisitedStep) maxVisitedStep = n;
    showDeploy = false;
    // On Screen 1 (index 1), fetch the recommendation for display + apply.
    // Also auto-select model defaults.
    if (n === 1 && !isRerun) {
      void fetchAndApplyRecommendation();
      applyImportedModelPreferences();
      autoSelectModels();
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
      // Step 1: store the key in OpenCode auth
      const res = await fetch('/api/setup/opencode/auth/' + encodeURIComponent(providerId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'api', key: st.apiKey }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? ('Failed to connect (HTTP ' + res.status + ')'));
      }

      // Step 2: validate by fetching models — proves the key actually works.
      // verifying stays true until verifyProvider clears it.
      // verifyProvider sets verified=true on success, error=true on failure.
      await verifyProvider(providerId);
      // verifyProvider sets st.verifying = false itself; return here so the
      // finally below does not double-clear it.
      return;
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

  async function handleDeployRetry(): Promise<void> {
    installing = false;
    deployError = null;
    deployDone = false;
    deployHasWarnings = false;
    deployData = {};
    lastDeployData = null;
    deployPollErrors = 0;
    const res = await fetch('/api/setup/retry-deploy', { method: 'POST' });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload?.ok === false) {
      deployError = payload?.message ?? 'Retry failed.';
      return;
    }
    installing = true;
    void pollDeployStatus();
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
    // Return to Review step (index 3)
    currentStep = 3;
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
        if (typeof data.hostAkmAvailable === 'boolean') {
          hostAkmAvailable = data.hostAkmAvailable;
          // Owner Decision 3: auto-default hostAkmEnabled = hostAkmAvailable.
          // No wizard UI for this — it's set automatically from detection.
          if (!isRerun) hostAkmEnabled = data.hostAkmAvailable;
        }
        hostStatusWarning = data.warning ?? null;
        // Eagerly store host model preferences so applyImportedModelPreferences()
        // works even on the fast path (providers already verified, no import needed).
        if (data.modelPreferences?.model) importedLlmModel = data.modelPreferences.model;
        if (data.modelPreferences?.small_model) importedSmallModel = data.modelPreferences.small_model;
        // Auto-import if already on Providers step (index 2), or always on rerun
        // so models/settings have verified providers to attach to.
        if (hostProviderCount > 0 && !hostImportTriggered && (currentStep === 1 || isRerun)) {
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
      // After host import, ensure we stay on Screen 1 (index 1).
      // goToStep(1) is a no-op if already there.
      if (!isRerun) goToStep(1);
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
      maxVisitedStep = 3;
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
</svelte:head>

<main class="setup-page" aria-label="Setup wizard">

  {#if isRerun}
    <div class="rerun-banner">
      <span>Updating existing installation</span>
      <a href="/" class="rerun-back-link">← Back to Admin</a>
    </div>
  {/if}

  <!-- SystemCheck: hidden step 0, mounted but invisible -->
  {#if currentStep === 0 && !showDeploy}
    <div style="display:none" aria-hidden="true">
      <section class="step-content step-content--hidden" id="step-0" data-testid="step-system-check">
        <SystemCheckStep
          {isRerun}
          onpass={() => { systemCheckPassed = true; goToStep(1); }}
          onnext={() => { systemCheckPassed = true; goToStep(1); }}
          ongpudetected={(_gpu) => {
            gpuDetected = true;
            if (voiceProfiles.length > 0 && selectedVoiceProfile !== addonProfileId('voice', 'cuda')) {
              const cuda = voiceProfiles.find((p) => p.id === addonProfileId('voice', 'cuda') && p.available !== false);
              if (cuda) selectedVoiceProfile = cuda.id;
            }
          }}
        />
      </section>
    </div>
  {/if}

  {#if showDeploy}
    <!-- Deploy: full width, no header chrome -->
    <div style="flex:1; padding: 32px; overflow-y: auto;">
      <DeployStep
        {deployData}
        {deployDone}
        {deployHasWarnings}
        {deployError}
        onback={handleDeployBack}
        onretry={handleDeployRetry}
      />
    </div>
  {:else if currentStep >= 1}
    <!-- Topbar -->
    <header class="wiz-topbar">
      <div class="wiz-wordmark">
        <img src="/logo-128.png" alt="OpenPalm" />
        <b>OpenPalm</b><span>setup</span>
      </div>
      <nav class="wiz-ticker" aria-label="Setup steps">
        {#each [
          { n: 1, label: 'Connect' },
          { n: 2, label: 'Add-ons' },
          { n: 3, label: 'Finish' },
        ] as tick}
          <div
            class="wiz-tick"
            class:wiz-tick--active={currentStep === tick.n}
            class:wiz-tick--done={currentStep > tick.n}
            aria-current={currentStep === tick.n ? 'step' : undefined}
          >
            {#if currentStep > tick.n}
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true"><path d="M2 6l3 3 5-5"/></svg>
            {:else}
              <span class="wiz-tick-num">{tick.n}</span>
            {/if}
            {tick.label}
          </div>
        {/each}
      </nav>
    </header>

    <!-- Stage: content + aside -->
    <div class="wiz-stage">
      <!-- Left: content -->
      <div class="wiz-content">
        <div class="wiz-content-scroll">
          <!-- Step header -->
          <div class="wiz-eyebrow">
            {#if currentStep === 1}STEP 1 · Connect
            {:else if currentStep === 2}STEP 2 · Add-ons
            {:else if currentStep === 3}STEP 3 · Finish
            {/if}
          </div>
          <h1 class="wiz-title">
            {#if currentStep === 1}Connect your <span class="accent">AI brain</span>
            {:else if currentStep === 2}Optional <span class="accent">extras</span>
            {:else if currentStep === 3}You're all <span class="accent">set</span>
            {/if}
          </h1>
          <p class="wiz-lede">
            {#if currentStep === 1}
              {#if hasUsableAI}We found an AI service already set up. Just continue, or choose something different.
              {:else}Your assistant needs a source of intelligence. Pick one and you're set — you can add more later.
              {/if}
            {:else if currentStep === 2}All optional — turn on only what you want now. You can add or remove anything later from your dashboard.
            {:else if currentStep === 3}OpenPalm is ready to install. Save the password you'll use to sign in.
            {/if}
          </p>

          <!-- Recommendation alert (step 1 only) -->
          {#if recommendationAlert && currentStep === 1}
            <div class="feedback feedback--warning" role="alert" data-testid="recommendation-alert">
              <span>{recommendationAlert}</span>
            </div>
          {/if}

          <!-- Step body -->
          {#if currentStep === 1}
            <section class="step-content" id="step-1">
              <Screen1ModelsStep
                {modelMode}
                detectionLoading={autoModeImporting}
                systemCheckError={systemCheckPassed ? '' : (step0Error || '')}
                hostProviders={detectedHostProviders}
                credentialCount={hostProviderCount}
                cloudProviders={detectedCloudProviders}
                {opencodeProviders}
                {opencodeAuth}
                {providerState}
                {ollamaEnabled}
                {selectedOllamaProfile}
                {hostImporting}
                {verifiedCount}
                {allowEmptyInstall}
                llmModel={modelSelection.llm?.model ?? ''}
                llmProvider={modelSelection.llm?.connId ?? ''}
                {llmModelOptions}
                {detectedCloudConn}
                onselectmodel={(connId, model, dims) => handleSelectModel('llm', connId, model, dims)}
                gpuVramMb={detectedGpuVramMb}
                gpuVendor={detectedGpuVendor}
                gpuName={detectedGpuName}
                onmodelmodechange={handleConnectModeChange}
                onhostimport={() => void handleHostImport()}
                onoauthstart={startOpenCodeOAuth}
                onoauthcancel={(id) => {
                  const ac = oauthAbortControllers[id];
                  if (ac) { ac.abort(); delete oauthAbortControllers[id]; }
                  const st = providerState[id];
                  if (st) { st.oauthPolling = false; st.verifying = false; }
                }}
                onbaseurl={handleBaseUrl}
                onapikey={handleApiKey}
                onverify={handleVerify}
                onrecheck={() => void fetchAndApplyRecommendation()}
                onsystemcheckretry={() => { goToStep(0); }}
                onallowemptyinstallchange={(v) => { allowEmptyInstall = v; }}
                onnext={() => goToStep(2)}
              />
            </section>

          {:else if currentStep === 2}
            <section class="step-content" id="step-2">
              <Screen2ExtrasStep
                {modelMode}
                {voiceEnabled}
                voiceTts={displayedVoiceTts}
                voiceStt={displayedVoiceStt}
                {hasOpenAI}
                voiceProfiles={voiceProfiles}
                {selectedVoiceProfile}
                {channelSelection}
                onvoiceenabledchange={(v) => {
                  voiceEnabled = v;
                  handleEnableVoiceChange(v);
                }}
                onchangetts={(v) => {
                  voiceTts = v;
                  voiceEngineUnknownTts = false;
                }}
                onchangestt={(v) => {
                  voiceStt = v;
                  voiceEngineUnknownStt = false;
                }}
                onvoiceprofilechange={(id) => { selectedVoiceProfile = id; }}
                onchanneltoggle={handleChannelToggle}
                oncredentialchange={handleCredentialChange}
                onnext={() => goToStep(3)}
              />
            </section>

          {:else if currentStep === 3}
            <section class="step-content" id="step-3" data-testid="step-review">
              <ReviewStep
                {uiLoginPassword}
                {verifiedProviders}
                {modelSelection}
                activeTts={voiceEnabled ? displayedVoiceTts.engine : ''}
                activeStt={voiceEnabled ? displayedVoiceStt.engine : ''}
                voiceProfileLabel={selectedVoiceProfileLabel}
                ollamaProfileLabel={selectedOllamaProfileLabel}
                {channelSelection}
                {ollamaEnabled}
                cloudOnly={modelMode === 'cloud' && !ollamaEnabled && detectedHostProviders.length === 0}
                hostProviderLabel={detectedHostProviders.length > 0 ? (detectedHostProviders[0].provider) : ''}
                {payload}
                {installError}
                {installing}
                {isRerun}
                {systemCheckPassed}
                onback={() => goToStep(2)}
                oninstall={handleInstall}
                oneditmodels={() => goToStep(1)}
                oneditextras={() => goToStep(2)}
              />
            </section>
          {/if}
        </div><!-- /wiz-content-scroll -->

        <!-- Footer: Back + Continue/Install -->
        <footer class="wiz-footer">
          <div class="wiz-footer-left">
            {#if currentStep > 1}
              <button
                class="btn btn-secondary"
                onclick={() => goToStep(currentStep - 1)}
                aria-label="Back"
              >
                Back
              </button>
            {:else}
              <div></div>
            {/if}
          </div>
          <div class="wiz-footer-right">
            {#if currentStep === 1}
              <button
                class="btn btn-primary"
                id="btn-screen1-next"
                onclick={() => goToStep(2)}
                disabled={!canComplete}
              >
                {#if modelSelection.llm?.connId && !(['ollama', 'lmstudio', 'llamacpp', 'localai', 'model-runner'].includes(modelSelection.llm.connId))}
                  Use {modelSelection.llm.connId === 'openai' ? 'ChatGPT' : modelSelection.llm.connId === 'google' ? 'Gemini' : modelSelection.llm.connId === 'github-copilot' ? 'GitHub Copilot' : modelSelection.llm.connId === 'groq' ? 'Groq' : (opencodeProviders.find((p) => p.id === modelSelection.llm!.connId)?.name ?? modelSelection.llm.connId)} — Continue
                {:else if ollamaEnabled || detectedHostProviders.length > 0 || (modelSelection.llm?.connId && ['ollama', 'lmstudio', 'llamacpp', 'localai', 'model-runner'].includes(modelSelection.llm.connId))}
                  Use local AI — Continue
                {:else}
                  Continue
                {/if}
              </button>
            {:else if currentStep === 2}
              <button
                class="btn btn-primary"
                id="btn-screen2-next"
                onclick={() => goToStep(3)}
              >
                Continue
              </button>
            {:else if currentStep === 3}
              <button
                class="btn btn-primary"
                id="btn-install"
                onclick={handleInstall}
                disabled={!canComplete || installing}
              >
                {#if installing}Installing...{:else}{isRerun ? 'Update' : 'Install'}{/if}
              </button>
            {/if}
          </div>
        </footer>
      </div><!-- /wiz-content -->

      <!-- Right: guide aside -->
      <aside class="wiz-aside" aria-label="Setup guide">
        <div class="wiz-aside-top">
          <img class="wiz-mascot" src="/wizard-128.png" alt="OpenPalm setup guide" />
          <div>
            <b class="wiz-greet-name">
              {#if currentStep === 1}
                {#if hasUsableAI}You're almost done!
                {:else if modelMode === 'local' || ollamaEnabled || detectedHostProviders.length > 0}Great choice.
                {:else}Pick what works for you.
                {/if}
              {:else if currentStep === 2}While you're here…
              {:else if currentStep === 3}You're ready.
              {/if}
            </b>
            <span class="wiz-greet-sub">
              {#if currentStep === 1}Your setup guide
              {:else if currentStep === 2}A few optional extras
              {:else if currentStep === 3}Everything's in order
              {/if}
            </span>
          </div>
        </div>

        <p class="wiz-guide-lede">
          {#if currentStep === 1}
            {#if hasUsableAI}We found an AI account on this computer. Just hit <strong>Continue</strong> and your assistant will use it automatically.
            {:else if modelMode === 'local' || ollamaEnabled || detectedHostProviders.length > 0}Running AI locally means your conversations never leave your machine. Perfect for privacy.
            {:else}Sign in once and you're set. A browser tab will open for you to log in — come back here when you're done, it connects automatically.
            {/if}
          {:else if currentStep === 2}All of this is optional. Skip this whole step if you want — your assistant works fine without any of these. You can turn them on whenever you're ready from the dashboard.
          {:else if currentStep === 3}You're ready. Click <strong>Install OpenPalm</strong> and it'll start up in the background. The first launch pulls a few files — this takes a minute or two. When it's done, open your browser, sign in with that password, and you're good to go. Everything can be changed later from the dashboard.
          {/if}
        </p>

        <div class="wiz-guide-bullets">
          {#if currentStep === 1}
            {#if hasUsableAI}
              <div class="wiz-bullet">
                <div class="wiz-bullet-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
                </div>
                <div>Your existing connection is ready to use. No extra setup needed — just continue to the next step.</div>
              </div>
              <div class="wiz-bullet">
                <div class="wiz-bullet-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3l1.5 4.5H18l-3.75 2.7 1.5 4.5L12 12l-3.75 2.7 1.5-4.5L6 7.5h4.5z"/></svg>
                </div>
                <div>Want to use something different? Select another option from the list — you can switch any time from the dashboard.</div>
              </div>
            {:else}
              <div class="wiz-bullet">
                <div class="wiz-bullet-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
                </div>
                <div><strong>Cloud services</strong> like ChatGPT are fast and easy — you just sign in.</div>
              </div>
              <div class="wiz-bullet">
                <div class="wiz-bullet-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
                </div>
                <div><strong>Running locally</strong> keeps everything on your computer — private, free, no internet needed.</div>
              </div>
            {/if}
          {:else if currentStep === 2}
            <div class="wiz-bullet">
              <div class="wiz-bullet-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>
              </div>
              <div>Voice runs locally — free, no internet needed. A small model downloads the first time you use it.</div>
            </div>
            <div class="wiz-bullet">
              <div class="wiz-bullet-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 3"/></svg>
              </div>
              <div>Setup help: <a href="https://discord.com/developers/docs/quick-start/getting-started" target="_blank" rel="noopener">How to set up a Discord bot →</a></div>
            </div>
            <div class="wiz-bullet">
              <div class="wiz-bullet-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
              </div>
              <div><a href="https://api.slack.com/quickstart" target="_blank" rel="noopener">How to set up a Slack app →</a></div>
            </div>
          {:else if currentStep === 3}
            <div class="wiz-bullet">
              <div class="wiz-bullet-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
              </div>
              <div>Your sign-in password is already saved on this computer — keep a copy somewhere safe just in case.</div>
            </div>
            <div class="wiz-bullet">
              <div class="wiz-bullet-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
              </div>
              <div>Everything can be changed from the dashboard after install — providers, voice, channels, and more.</div>
            </div>
          {/if}
        </div>

        <div class="wiz-guide-privacy">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M8 1.5L2 4v4c0 3.3 2.5 5.8 6 6.5 3.5-.7 6-3.2 6-6.5V4L8 1.5z"/>
          </svg>
          <span>It's your own assistant, running right here on your computer.</span>
        </div>
      </aside>
    </div><!-- /wiz-stage -->
  {/if}

</main>
