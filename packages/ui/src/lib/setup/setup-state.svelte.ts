/**
 * Setup wizard state — the reactive state + derivations that drive the
 * 3-screen setup flow (routes/setup/+page.svelte) and its step components.
 *
 * Hoisted out of `routes/setup/+page.svelte` (which held ~50 `$state`/`$derived`
 * declarations and drilled ~20 props into `Screen1ModelsStep` and ~15 into
 * `ReviewStep`). The step components now read this store directly instead of
 * receiving individually-threaded props — matching the store-per-domain pattern
 * used by `endpoints-state.svelte.ts`, `theme-state.svelte.ts`, and
 * `chat-state.svelte.ts`.
 *
 * The pure collaborators stay pure: `buildSetupPayload`/`parseSetupConfig`
 * ($lib/setup/payload.ts) and the data-access layer ($lib/setup-api.ts) are
 * called by this store; they never import it back.
 *
 * Reactivity notes (Svelte 5 runes, mirrors chat-state.svelte.ts):
 *  - `providerState`/`modelSelection`/`portalSelection` are `$state` records;
 *    both in-place nested mutation (`st.verified = true`) and whole-object
 *    reassignment (`this.providerState = next`) fire subscribers because
 *    `$state` deep-proxies plain objects.
 *  - `enableVoice`, `canComplete`, and `payload` are DERIVED, never
 *    effect-synced. A past bug had an `$effect` flip `allowEmptyInstall` off on
 *    every background verification, which "silently moved the checkbox under the
 *    user". Keep these as `$derived` — do NOT reintroduce that effect.
 */
import {
  PROVIDERS, LOCAL_PROVIDERS, OLLAMA_DEFAULT_CHAT_MODEL, LOCAL_PROVIDER_IDS,
} from '$lib/client/constants.js';
import {
  buildModelOptions, selectAddonProfileId, resolveVoiceSide,
  generatePassword, buildVerifiedProviders,
  computeAutoModelSelection, resolvePreferredModelSelection,
} from '$lib/client/helpers.js';
import { buildSetupPayload, parseSetupConfig } from '$lib/setup/payload.js';
import {
  fetchVoiceProfiles, fetchOllamaProfiles, fetchRecommendation,
  ensureOpenCode, fetchOpenCodeStatus, fetchOpenCodeProviders,
  fetchDetectedProviders, fetchProviderModels,
  authorizeOpenCodeOAuth, pollOpenCodeOAuthCallback,
  completeSetup, fetchDeployStatus, retryDeploy,
  fetchHostStatus, importHost, fetchCurrentConfig, fetchSetupStatus,
} from '$lib/setup-api.js';
import type {
  ProviderState, ModelSelection, DetectedProvider, PortalState,
  OpenCodeProvider, AuthMethod, VoiceEngineValue, Provider,
} from '$lib/client/types.js';
import type { VoiceAddonProfile } from '$lib/api.js';
import type { SetupRecommendation } from '@openpalm/lib';
import { addonProfileId } from '@openpalm/lib/provider-constants';

export type ModelMode = 'cloud' | 'local' | 'both';

interface DeployData {
  deploying?: boolean;
  setupComplete?: boolean;
  deployStatus?: { service: string; status: string; label?: string }[];
  deployError?: string | null;
  ports?: { admin?: number; assistant?: number };
}

export class SetupState {
  // ── Navigation state ───────────────────────────────────────────────────────
  currentStep = $state(0);
  maxVisitedStep = $state(0);
  showDeploy = $state(false);
  systemCheckPassed = $state(false);

  // ── Model mode + explicit voice toggle (new 3-screen flow) ─────────────────
  // modelMode: which high-level option the user chose on Screen 1.
  // Pre-set to 'cloud'; detection may update it before Screen 1 renders.
  modelMode = $state<ModelMode>('cloud');
  // voiceEnabled: explicit toggle state — OFF by default, always.
  // Separate from the `enableVoice` derived (which drives the payload).
  // Screen2ExtrasStep reads this and only sets engine values when true.
  voiceEnabled = $state(false);

  // ── Step 0: Welcome ─────────────────────────────────────────────────────────
  // Operator UI login password — replaces the legacy "admin token" UI.
  uiLoginPassword = $state('');
  step0Error = $state('');
  // True while auto mode is performing a host provider import before jumping to Review
  autoModeImporting = $state(false);
  // Set when System Check detects a GPU — used to auto-select CUDA voice profile
  gpuDetected = $state(false);

  // ── Step 1: Providers ───────────────────────────────────────────────────────
  providerState = $state<Record<string, ProviderState>>({});
  // Local LLM runtimes detected running on the host (ollama/lmstudio/model-runner).
  detectedHostProviders = $state<{ provider: string; url: string }[]>([]);
  detectedProviders = $state<DetectedProvider[]>([]);
  opencodeAvailable = $state(false);
  opencodeProviders = $state<OpenCodeProvider[]>([]);
  opencodeAuth = $state<Record<string, AuthMethod[]>>({});
  // Host import detection
  hostProviderCount = $state(0);
  allowEmptyInstall = $state(false);
  // Setup recommendation (from /api/setup/recommend).
  recommendation = $state<SetupRecommendation | null>(null);
  recommendationAlert = $state('');
  recommendationApplied = $state(false);
  // Raw detection data from /api/setup/recommend (stored separately for Screen1 props)
  detectedGpuVramMb = $state(0);
  detectedGpuVendor = $state('');
  detectedGpuName = $state('');
  /** Generation counter per provider — discard stale verify results */
  private verifyGeneration: Record<string, number> = {};
  /** AbortControllers for in-flight OAuth long-poll requests */
  private oauthAbortControllers: Record<string, AbortController> = {};

  // ── Step 2: Models ──────────────────────────────────────────────────────────
  modelSelection = $state<{ llm?: ModelSelection; embedding?: ModelSelection; small?: ModelSelection }>({});

  // ── Step 3: Voice ───────────────────────────────────────────────────────────
  // VoiceEngineValue holds engine id + per-engine settings (model/voice/language).
  voiceTts = $state<VoiceEngineValue>({ engine: '' });
  voiceStt = $state<VoiceEngineValue>({ engine: '' });
  // Hardware profiles for the bundled OpenPalm Voice addon (CPU / CUDA / …)
  voiceProfiles = $state<VoiceAddonProfile[]>([]);
  selectedVoiceProfile = $state('');
  // Imported OpenCode model preferences (from host opencode.json)
  importedLlmModel = $state<string | undefined>(undefined);
  importedSmallModel = $state<string | undefined>(undefined);

  // ── Step 4: Options ─────────────────────────────────────────────────────────
  portalSelection = $state<Record<string, boolean | PortalState>>({
    discord: { enabled: false, botToken: '', applicationId: '' },
    slack: { enabled: false, slackBotToken: '', slackAppToken: '' },
  });
  ollamaEnabled = $state(false);
  ollamaProfiles = $state<VoiceAddonProfile[]>([]);
  selectedOllamaProfile = $state('');
  imageTag = $state('');
  hostAkmEnabled = $state(false);

  // ── Step 5: Review + Install ─────────────────────────────────────────────────
  installError = $state('');
  installing = $state(false);
  // Single explicit acknowledgment for an empty-AI install.
  emptyAiAck = $state(false);

  // ── Deploy screen ────────────────────────────────────────────────────────────
  deployData = $state<DeployData>({});
  deployDone = $state(false);
  // Terminal state where remaining non-running rows are warnings (e.g. voice
  // still warming). Setup IS complete — "Done (with warnings)", not an error.
  deployHasWarnings = $state(false);
  deployError = $state<string | null>(null);
  deployPollErrors = $state(0);
  private deployTimer: ReturnType<typeof setInterval> | null = null;

  // ── Connect-step row selection: cloud ↔ local actually switches the model ──
  savedCloudLlm = $state<ModelSelection | undefined>(undefined);
  // Stable "detected cloud service" connId — captured once so the cloud row stays
  // visible even after the user switches to local (lets them switch back).
  // NOTE: declared after modelSelection so its initializer can read it.
  detectedCloudConn = $state(
    this.modelSelection.llm && !LOCAL_PROVIDER_IDS.has(this.modelSelection.llm.connId)
      ? this.modelSelection.llm.connId
      : ''
  );

  // ── Host import ──────────────────────────────────────────────────────────────
  hostImportTriggered = $state(false);
  hostImporting = $state(false);
  // Surfaced on the Providers step when a host import fails.
  hostImportError = $state('');

  isRerun = $state(false);

  // ── Derived ──────────────────────────────────────────────────────────────────
  hostLocalLlmRunning = $derived(
    this.providerState['ollama']?.ollamaMode === 'running' ||
      this.detectedHostProviders.some((p) => p.provider === 'ollama' || p.provider === 'lmstudio'),
  );

  verifiedCount = $derived.by(() => {
    const ids = this.opencodeAvailable
      ? this.opencodeProviders.map((p) => p.id)
      : PROVIDERS.map((p) => p.id);
    return ids.filter((id) => this.providerState[id]?.verified).length;
  });

  // True only when a usable chat model is actually selected — drives the
  // step-1 "we found an AI" vs "pick one" copy.
  hasUsableAI = $derived(!!this.modelSelection.llm?.model);

  verifiedProviders: Provider[] = $derived(
    buildVerifiedProviders(this.opencodeAvailable, this.opencodeProviders, this.providerState),
  );

  // ── Single source of truth for "can the user finish setup?" ──────────────
  // Expressed as a derived predicate (NOT a state-mutating $effect that flipped
  // `allowEmptyInstall` off on every background verification — that silently
  // moved the checkbox under the user). Can finish when an actual chat model is
  // selected, OR the user explicitly opted to skip AI for now.
  canComplete = $derived(
    !!this.modelSelection.llm?.model || this.allowEmptyInstall,
  );

  hasOpenAI = $derived(
    PROVIDERS.some((p) => p.id === 'openai' && this.providerState[p.id]?.verified)
  );

  voiceDefaults = $derived(this.hasOpenAI
    ? { tts: 'openai-tts', stt: 'openai-stt' }
    : { tts: 'browser-tts', stt: 'browser-stt' });

  // "Voice enabled" = the bundled OpenPalm Voice engine is selected on either
  // side. DERIVED (not manually-synced state) so it can never drift from the
  // engines after rerun deserialization or any out-of-band engine edit.
  enableVoice = $derived(
    this.voiceTts.engine === 'openpalm-voice' || this.voiceStt.engine === 'openpalm-voice',
  );

  // Resolve one voice side (tts|stt): an explicit engine wins; else OpenPalm
  // Voice when the bundled voice is enabled; else the given fallback. The
  // `displayed*` derivations pass a sensible default engine (for the UI); the
  // `persisted*` ones pass '' (an empty engine means "don't save this side").
  displayedVoiceTts = $derived(resolveVoiceSide(this.voiceTts, this.enableVoice, this.voiceDefaults.tts));
  displayedVoiceStt = $derived(resolveVoiceSide(this.voiceStt, this.enableVoice, this.voiceDefaults.stt));
  persistedVoiceTts = $derived(resolveVoiceSide(this.voiceTts, this.enableVoice, ''));
  persistedVoiceStt = $derived(resolveVoiceSide(this.voiceStt, this.enableVoice, ''));

  // Build the install payload for /api/setup/complete. The pure builder lives
  // in $lib/setup/payload.ts (round-trip tested against parseSetupConfig).
  payload = $derived(buildSetupPayload({
    modelSelection: this.modelSelection,
    verifiedProviders: this.verifiedProviders,
    providerState: this.providerState,
    ollamaEnabled: this.ollamaEnabled,
    hostLocalLlmRunning: this.hostLocalLlmRunning,
    persistedVoiceTts: this.persistedVoiceTts,
    persistedVoiceStt: this.persistedVoiceStt,
    selectedVoiceProfile: this.selectedVoiceProfile,
    selectedOllamaProfile: this.selectedOllamaProfile,
    portalSelection: this.portalSelection,
    uiLoginPassword: this.uiLoginPassword,
    imageTag: this.imageTag,
    hostAkmEnabled: this.hostAkmEnabled,
  }));

  // ── Profile loaders ──────────────────────────────────────────────────────────

  async loadVoiceProfiles(): Promise<void> {
    try {
      const data = await fetchVoiceProfiles();
      if (!data) return;
      if (!Array.isArray(data.profiles)) return;
      this.voiceProfiles = data.profiles;

      // Auto-select the best profile: CUDA if GPU detected, otherwise CPU/default.
      const fallback = selectAddonProfileId(data.profiles, 'voice', this.gpuDetected);
      if (fallback) this.selectedVoiceProfile = fallback;

      // gpuDetected may have been set after this fetch started — upgrade now
      if (this.gpuDetected && this.selectedVoiceProfile !== addonProfileId('voice', 'cuda')) {
        const cuda = this.voiceProfiles.find((p) => p.id === addonProfileId('voice', 'cuda') && p.available !== false);
        if (cuda) this.selectedVoiceProfile = cuda.id;
      }
    } catch {
      // non-critical
    }
  }

  async loadOllamaProfiles(): Promise<void> {
    try {
      const data = await fetchOllamaProfiles();
      if (!data) return;
      if (!Array.isArray(data.profiles)) return;
      this.ollamaProfiles = data.profiles;

      const fallback = this.gpuDetected
        ? data.profiles.find((p) => p.id === addonProfileId('ollama', 'cuda') && p.available !== false)
          ?? data.profiles.find((p) => p.default && p.available !== false)
          ?? data.profiles.find((p) => p.available !== false)
        : data.profiles.find((p) => p.id === addonProfileId('ollama', 'cpu') && p.available !== false)
          ?? data.profiles.find((p) => p.default && p.available !== false)
          ?? data.profiles.find((p) => p.available !== false);
      if (data.selectedProfile && typeof data.selectedProfile === 'string') {
        this.selectedOllamaProfile = data.selectedProfile;
      } else if (fallback) {
        this.selectedOllamaProfile = fallback.id;
      }
    } catch {
      // non-critical
    }
  }

  initProviderState(): void {
    const state: Record<string, ProviderState> = {};
    for (const p of PROVIDERS) {
      state[p.id] = {
        selected: false, verified: false, verifying: false, error: false,
        apiKey: '', baseUrl: p.baseUrl ?? '', models: [], ollamaMode: null,
      };
    }
    this.providerState = state;
  }

  enableRecommendedOllama(variant?: 'cuda' | 'rocm' | 'cpu'): void {
    this.ollamaEnabled = true;
    const st = this.providerState['ollama'];
    if (st) {
      st.selected = true;
      st.verified = true;
      st.ollamaMode = 'instack';
      st.baseUrl = 'http://ollama:11434';
      // Seed only the chat model, using the client-safe default constant. akm
      // self-embeds locally, so the wizard must NOT configure embeddings by
      // default (no nomic-embed-text seed).
      if (st.models.length === 0) st.models = [OLLAMA_DEFAULT_CHAT_MODEL];
    }
    // Prefer the recommended hardware variant; otherwise fall back to the
    // ad-hoc GPU-detection guess.
    this.selectedOllamaProfile = selectAddonProfileId(this.ollamaProfiles, 'ollama', this.gpuDetected, variant)
      ?? addonProfileId('ollama', variant ?? (this.gpuDetected ? 'cuda' : 'cpu'));
  }

  handleConnectModeChange(mode: 'cloud' | 'local' | 'both'): void {
    this.modelMode = mode;
    if (mode === 'local') {
      // Remember the cloud model so switching back restores it.
      if (this.modelSelection.llm && !LOCAL_PROVIDER_IDS.has(this.modelSelection.llm.connId)) {
        this.savedCloudLlm = this.modelSelection.llm;
      }
      // Use a detected host runtime if present; otherwise enable in-stack Ollama.
      if (!this.hostLocalLlmRunning) this.enableRecommendedOllama();
      // Point the chat model at the local runtime so the install + button reflect it.
      const localOpt = this.getModelOptionsForRole('llm').find((o) => LOCAL_PROVIDER_IDS.has(o.connId));
      this.modelSelection.llm = localOpt
        ? { connId: localOpt.connId, model: localOpt.id, dims: localOpt.dims }
        : { connId: 'ollama', model: OLLAMA_DEFAULT_CHAT_MODEL, dims: 0 };
    } else if (mode === 'cloud') {
      if (this.savedCloudLlm) this.modelSelection.llm = this.savedCloudLlm;
    }
  }

  // Fetch the GPU/provider-aware setup recommendation once and apply it. Safe to
  // call multiple times — applies only once. Reuses a recommendation already
  // fetched for display (fetchRecommendation()).
  async fetchAndApplyRecommendation(): Promise<void> {
    if (this.recommendationApplied) return;
    let rec: SetupRecommendation;
    if (this.recommendation) {
      rec = this.recommendation;
    } else {
      try {
        const data = await fetchRecommendation();
        if (!data) return;
        if (!data.ok || !data.recommendation) return;
        rec = data.recommendation;
        if (Array.isArray(data.hostProviders)) this.detectedHostProviders = data.hostProviders;
        if (data.gpu) {
          this.detectedGpuVramMb = data.gpu.vramMb ?? 0;
          this.detectedGpuVendor = data.gpu.vendor ?? '';
          this.detectedGpuName = data.gpu.name ?? '';
        }
      } catch (e) {
        // non-critical — user can configure manually, but warn so a broken
        // recommend endpoint (which would suppress auto host-import) is visible.
        console.warn('fetchAndApplyRecommendation failed', e);
        return;
      }
    }
    this.recommendationApplied = true;
    this.recommendation = rec;

    switch (rec.action) {
      case 'use-cloud':
        // A cloud provider is already connected — nothing to auto-do.
        this.recommendationAlert = '';
        break;
      case 'use-host-providers': {
        this.recommendationAlert = rec.alert;
        // Import host ollama/lmstudio so they become real providers.
        if (!this.hostImportTriggered) {
          this.hostImportTriggered = true;
          await this.handleHostImport();
        }
        break;
      }
      case 'enable-ollama':
        this.recommendationAlert = rec.alert;
        this.enableRecommendedOllama(rec.profileVariant);
        break;
      case 'connect-manually':
        // Keep the user on the Providers step with the alert visible.
        this.recommendationAlert = rec.alert;
        break;
    }
  }

  handleEnableVoiceChange(v: boolean): void {
    // enableVoice is derived from the engines below — toggling drives the
    // engines, and the derived follows.
    if (v) {
      // Toggle ON → make the Voice step concretely reflect OpenPalm Voice on
      // both sides (unless they already target it).
      if (this.voiceTts.engine !== 'openpalm-voice') this.voiceTts = { engine: 'openpalm-voice' };
      if (this.voiceStt.engine !== 'openpalm-voice') this.voiceStt = { engine: 'openpalm-voice' };
      if (!this.selectedVoiceProfile) {
        const match = selectAddonProfileId(this.voiceProfiles, 'voice', this.gpuDetected);
        if (match) this.selectedVoiceProfile = match;
      }
    } else {
      // Toggle OFF → clear any OpenPalm Voice engine back to "not chosen".
      if (this.voiceTts.engine === 'openpalm-voice') this.voiceTts = { engine: '' };
      if (this.voiceStt.engine === 'openpalm-voice') this.voiceStt = { engine: '' };
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────────

  goToStep(n: number): void {
    if (n < 0 || n > 3) return;
    // Block forward navigation past System Check until it has passed.
    // Allow backwards navigation freely so users can revisit the check.
    if (n > 0 && !this.systemCheckPassed) return;
    this.currentStep = n;
    if (n > this.maxVisitedStep) this.maxVisitedStep = n;
    this.showDeploy = false;
    // On Screen 1 (index 1), fetch the recommendation for display + apply.
    // Also auto-select model defaults.
    if (n === 1 && !this.isRerun) {
      void this.fetchAndApplyRecommendation();
      this.applyImportedModelPreferences();
      this.autoSelectModels();
    }
  }

  // Fill unset chat/small roles with the best-ranked option. Pure logic lives in
  // computeAutoModelSelection (helpers.ts); apply it in-place so already-set
  // roles are preserved (embedding is never auto-selected).
  autoSelectModels(): void {
    const next = computeAutoModelSelection(this.modelSelection, this.verifiedProviders, this.providerState);
    for (const roleId of ['llm', 'small'] as const) {
      if (!this.modelSelection[roleId] && next[roleId]) this.modelSelection[roleId] = next[roleId];
    }
  }

  // Shared, ranked, embedding-filtered option builder (helpers.ts) — the SAME
  // implementation the Models step uses.
  getModelOptionsForRole(roleId: 'llm' | 'embedding' | 'small'): Array<{ id: string; connId: string; isDefault: boolean; dims: number }> {
    return buildModelOptions(roleId, this.verifiedProviders, this.providerState);
  }

  applyImportedOpenCodeModelSelections(selectedModels?: { llm?: string; small?: string }): void {
    if (!selectedModels) return;

    // Store for re-application after autoSelectModels
    if (selectedModels.llm) this.importedLlmModel = selectedModels.llm;
    if (selectedModels.small) this.importedSmallModel = selectedModels.small;

    this.applyImportedModelPreferences();
  }

  applyImportedModelPreferences(): void {
    if (this.importedLlmModel) {
      const llmSelection = resolvePreferredModelSelection('llm', this.importedLlmModel, this.verifiedProviders, this.providerState);
      if (llmSelection) this.modelSelection.llm = llmSelection;
    }

    if (this.importedSmallModel) {
      const smallSelection = resolvePreferredModelSelection('small', this.importedSmallModel, this.verifiedProviders, this.providerState);
      if (smallSelection) this.modelSelection.small = smallSelection;
    }
  }

  // ── Provider API calls ──────────────────────────────────────────────────────

  async checkOpenCodeAndInit(): Promise<void> {
    try {
      // Ensure OpenCode is running — starts a dedicated instance if not already up
      const ensured = await ensureOpenCode();
      if (ensured?.ok) {
        this.opencodeAvailable = true;
        await this.loadOpenCodeProviders();
        return;
      }
    } catch {
      // fall through to status check
    }
    // Fallback: check if OpenCode is reachable at the configured URL
    try {
      const data = await fetchOpenCodeStatus();
      if (data?.available) {
        this.opencodeAvailable = true;
        await this.loadOpenCodeProviders();
      }
    } catch {
      // fall back to hardcoded providers
    }
  }

  async loadOpenCodeProviders(): Promise<void> {
    const data = await fetchOpenCodeProviders();
    if (!data) return;
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

    this.opencodeProviders = providers;
    this.opencodeAuth = auth;

    // Initialize providerState for each OpenCode provider
    const newState = { ...this.providerState };
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
    this.providerState = newState;

    this.applyImportedOpenCodeModelSelections(data.selectedModels as { llm?: string; small?: string } | undefined);
  }

  async detectProviders(): Promise<void> {
    try {
      const data = await fetchDetectedProviders();
      if (data) {
        this.detectedProviders = data.providers ?? [];
        for (const dp of this.detectedProviders) {
          if (!dp.available) continue;
          const st = this.providerState[dp.provider];
          if (st) {
            st.baseUrl = dp.url;
            if (!st.selected) {
              st.selected = true;
              if (dp.provider === 'ollama') st.ollamaMode = 'running';
            }
            // Always auto-verify detected local providers regardless of whether
            // OpenCode is available — "Mark as ready" doesn't test connectivity
            void this.verifyProvider(dp.provider);
          }
        }
      }
    } catch {
      this.detectedProviders = [];
    }
  }

  async verifyProvider(id: string): Promise<void> {
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) return;
    const st = this.providerState[id];
    if (!st) return;

    // For ollama instack mode, just mark verified
    if (id === 'ollama' && st.ollamaMode === 'instack') {
      st.verified = true;
      st.error = false;
      return;
    }

    const gen = (this.verifyGeneration[id] ?? 0) + 1;
    this.verifyGeneration[id] = gen;

    st.verifying = true;
    st.error = false;

    const baseUrl = (st.baseUrl || p.baseUrl).trim();
    const apiKey = (st.apiKey ?? '').trim();

    try {
      const result = await fetchProviderModels(id, { baseUrl, apiKey });
      if (this.verifyGeneration[id] !== gen) return;
      st.verified = true;
      st.error = false;
      st.models = result.models ?? [];
    } catch (e) {
      if (this.verifyGeneration[id] !== gen) return;
      st.verified = false;
      st.error = true;
      st.errorMessage = e instanceof Error ? e.message : '';
      st.models = [];
    }

    st.verifying = false;
  }

  // ── OpenCode auth ────────────────────────────────────────────────────────────

  async startOpenCodeOAuth(providerId: string, methodIndex: number): Promise<void> {
    const st = this.providerState[providerId];
    if (!st) return;

    st.verifying = true;
    st.error = false;

    try {
      const oauthRes = await authorizeOpenCodeOAuth(providerId, methodIndex);

      st.oauthPolling = true;
      st.oauthUrl = oauthRes.url ?? '';
      st.oauthInstructions = oauthRes.instructions ?? '';

      if (oauthRes.url && oauthRes.method === 'auto') {
        window.open(oauthRes.url, '_blank');
      }

      await this.pollOpenCodeOAuth(providerId, methodIndex);
    } catch (e) {
      st.verifying = false;
      st.error = true;
      st.errorMessage = e instanceof Error ? e.message : 'OAuth failed';
      st.oauthPolling = false;
    }
  }

  async pollOpenCodeOAuth(providerId: string, methodIndex: number): Promise<void> {
    const st = this.providerState[providerId];
    const ac = new AbortController();
    this.oauthAbortControllers[providerId] = ac;

    // Combine user-cancellation AbortController with a 10-minute timeout
    const timeoutSignal = AbortSignal.timeout(10 * 60_000);
    const combinedSignal = AbortSignal.any
      ? AbortSignal.any([ac.signal, timeoutSignal])
      : ac.signal;

    try {
      // The callback is a long-poll — make one call and wait (up to 10 minutes)
      const { ok, data } = await pollOpenCodeOAuthCallback(providerId, methodIndex, combinedSignal);
      if (ok && data?.ok) {
        st.verified = true;
        st.error = false;
      } else {
        st.error = true;
        st.errorMessage = data?.message ?? 'Authorization failed';
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
      delete this.oauthAbortControllers[providerId];
      st.oauthPolling = false;
      st.verifying = false;
    }
  }

  cancelOAuth(id: string): void {
    const ac = this.oauthAbortControllers[id];
    if (ac) { ac.abort(); delete this.oauthAbortControllers[id]; }
    const st = this.providerState[id];
    if (st) { st.oauthPolling = false; st.verifying = false; }
  }

  // ── Install & deploy ─────────────────────────────────────────────────────────

  async handleInstall(): Promise<void> {
    if (this.installing) return;
    this.installError = '';

    // Single "no AI configured" confirmation. When the payload has no `llm`,
    // require one explicit acknowledgment before installing. Rerun keeps
    // existing config, so don't re-prompt there.
    const payloadHasLlm = !!this.payload.llm;
    if (!payloadHasLlm && !this.isRerun && !this.emptyAiAck) {
      const ok = window.confirm(
        'No AI is set up here. You can connect this app to an assistant running on another computer, or add a provider later from your dashboard.\n\nInstall now?',
      );
      if (!ok) return;
      this.emptyAiAck = true;
    }

    this.installing = true;

    // Ensure a voice profile is selected when voice is enabled.
    const usesBundledVoice = this.persistedVoiceTts.engine === 'openpalm-voice' || this.persistedVoiceStt.engine === 'openpalm-voice';
    if (usesBundledVoice && !this.selectedVoiceProfile) {
      this.selectedVoiceProfile = selectAddonProfileId(this.voiceProfiles, 'voice', this.gpuDetected)
        ?? addonProfileId('voice', 'cpu');
    }

    // Ensure an Ollama profile is selected when Ollama is enabled in-stack.
    if (this.ollamaEnabled && !this.selectedOllamaProfile) {
      this.selectedOllamaProfile = addonProfileId('ollama', this.gpuDetected ? 'cuda' : 'cpu');
    }

    try {
      const { ok, data } = await completeSetup(this.payload);

      if (!ok || !data.ok) {
        // Docker-down and any other failure: surface the human-readable message
        // and STOP. Do not flip into showDeploy / the polling "Preparing…"
        // spinner — there's no deploy to poll, so doing so would hang forever.
        this.installError = data.message ?? data.error ?? 'Install failed.';
        this.installing = false;
        this.showDeploy = false;
        return;
      }

      this.showDeploy = true;
      this.startDeployPolling();
    } catch (e) {
      this.installError = 'Network error: ' + (e instanceof Error ? e.message : 'unable to reach server.');
      this.installing = false;
    }
  }

  startDeployPolling(): void {
    this.stopDeployPolling();
    void this.pollDeployStatus();
    this.deployTimer = setInterval(() => { void this.pollDeployStatus(); }, 2500);
  }

  stopDeployPolling(): void {
    if (this.deployTimer) { clearInterval(this.deployTimer); this.deployTimer = null; }
  }

  async pollDeployStatus(): Promise<void> {
    try {
      const { ok, data } = await fetchDeployStatus();
      if (!ok || !data) {
        this.deployPollErrors++;
        if (this.deployPollErrors >= 5) {
          // Lost contact with the installer — surface a real error instead of
          // pretending the deploy succeeded.
          this.stopDeployPolling();
          this.deployError = 'Lost contact with the installer. Services may still be starting in the background.';
        }
        return;
      }
      this.deployPollErrors = 0;

      this.deployData = data;

      if (data.deployError) {
        this.stopDeployPolling();
        this.deployError = data.deployError;
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
          this.stopDeployPolling();
          this.deployDone = true;
        } else if (onlyWarningsLeft) {
          this.stopDeployPolling();
          this.deployHasWarnings = true;
          this.deployDone = true;
        }
      } else if (data.setupComplete && !data.deploying && (!data.deployStatus || data.deployStatus.length === 0)) {
        this.stopDeployPolling();
        this.deployDone = true;
      }
    } catch (err) {
      this.deployPollErrors++;
      if (this.deployPollErrors >= 5) {
        this.stopDeployPolling();
        this.deployError = err instanceof Error
          ? `Lost contact with the installer: ${err.message}`
          : 'Lost contact with the installer.';
      }
    }
  }

  // ── Event handlers for child components ──────────────────────────────────────

  handlePortalToggle(id: string): void {
    const sel = this.portalSelection[id];
    if (typeof sel === 'object' && sel !== null) {
      sel.enabled = !sel.enabled;
    } else {
      this.portalSelection[id] = !sel;
    }
  }

  handleCredentialChange(chId: string, credKey: string, value: string): void {
    const sel = this.portalSelection[chId];
    if (typeof sel === 'object' && sel !== null) {
      sel[credKey] = value;
    }
  }

  async handleDeployRetry(): Promise<void> {
    this.installing = false;
    this.deployError = null;
    this.deployDone = false;
    this.deployHasWarnings = false;
    this.deployData = {};
    this.deployPollErrors = 0;
    const { ok, data } = await retryDeploy();
    if (!ok || data?.ok === false) {
      this.deployError = data?.message ?? 'Retry failed.';
      return;
    }
    this.installing = true;
    void this.pollDeployStatus();
  }

  handleDeployBack(): void {
    this.installing = false;
    this.deployError = null;
    this.deployDone = false;
    this.deployHasWarnings = false;
    this.deployData = {};
    this.deployPollErrors = 0;
    this.showDeploy = false;
    // Return to Review step (index 3)
    this.currentStep = 3;
  }

  // ── System check ─────────────────────────────────────────────────────────────

  handleSystemCheckPass(): void {
    this.systemCheckPassed = true;
    this.goToStep(1);
  }

  handleGpuDetected(): void {
    this.gpuDetected = true;
    if (this.voiceProfiles.length > 0 && this.selectedVoiceProfile !== addonProfileId('voice', 'cuda')) {
      const cuda = this.voiceProfiles.find((p) => p.id === addonProfileId('voice', 'cuda') && p.available !== false);
      if (cuda) this.selectedVoiceProfile = cuda.id;
    }
  }

  // ── Host import ──────────────────────────────────────────────────────────────

  async loadHostStatus(): Promise<void> {
    try {
      // Use setup-namespace endpoint — no admin auth needed during setup
      const data = await fetchHostStatus();
      if (data) {
        this.hostProviderCount = Math.max(data.providerCount ?? 0, data.credentialCount ?? 0);
        if (data.imageTag && !this.imageTag) this.imageTag = data.imageTag;
        if (typeof data.hostAkmAvailable === 'boolean') {
          // Owner Decision 3: auto-default hostAkmEnabled = hostAkmAvailable.
          // No wizard UI for this — it's set automatically from detection.
          if (!this.isRerun) this.hostAkmEnabled = data.hostAkmAvailable;
        }
        // Eagerly store host model preferences so applyImportedModelPreferences()
        // works even on the fast path (providers already verified, no import needed).
        if (data.modelPreferences?.model) this.importedLlmModel = data.modelPreferences.model;
        if (data.modelPreferences?.small_model) this.importedSmallModel = data.modelPreferences.small_model;
        // Auto-import if already on Providers step (index 1), or always on rerun
        // so models/settings have verified providers to attach to.
        if (this.hostProviderCount > 0 && !this.hostImportTriggered && (this.currentStep === 1 || this.isRerun)) {
          this.hostImportTriggered = true;
          void this.handleHostImport();
        }
      }
    } catch (e) {
      // non-critical — the wizard still works without host status, but warn so
      // a broken host-status endpoint (which suppresses auto-import) is visible.
      console.warn('loadHostStatus failed', e);
    }
  }

  markProviderVerifiedFromImport(id: string): void {
    let st = this.providerState[id];
    if (!st) {
      // OpenCode provider not yet in state — seed a minimal verified entry so
      // the imported provider still counts toward verifiedProviders.
      st = {
        selected: true, verified: true, verifying: false, error: false,
        apiKey: '', baseUrl: '', models: [], ollamaMode: null,
      };
      this.providerState[id] = st;
      return;
    }
    st.verified = true;
    st.error = false;
  }

  async handleHostImport(): Promise<void> {
    this.hostImporting = true;
    this.hostImportError = '';
    try {
      // Use setup-namespace endpoint — no admin auth needed during setup
      const { ok, data } = await importHost();

      if (!ok || !data?.ok) {
        // Hard failure (could not copy host config). Keep the user on the
        // Providers step with a clear message instead of silently doing nothing.
        this.hostImportError =
          data?.error ?? `Couldn't import providers from this computer. You can sign in or add a provider manually instead.`;
        this.hostImporting = false;
        return;
      }

      // Mark every imported provider verified directly from the response. This
      // does NOT depend on OpenCode being reachable: the credentials are on
      // disk and provider-consuming services read them on start.
      const importedIds = data.importedProviders ?? data.pushedProviders ?? [];
      for (const id of importedIds) this.markProviderVerifiedFromImport(id);

      // Reload providers when OpenCode is reachable so the full catalog +
      // env-detected credentials are reflected. Non-fatal if it can't run.
      if (this.opencodeAvailable) {
        try {
          await this.loadOpenCodeProviders();
        } catch (e) {
          // Non-fatal: the import already marked providers verified.
          console.warn('handleHostImport: reloading OpenCode providers failed', e);
        }
      }

      // First pass: apply imported model preferences from whatever models are
      // already loaded (host provider may already be populated by the reload).
      this.applyImportedModelPreferences();

      // Verify local providers to fetch live models. AWAIT them so the host
      // model preference (and host-over-Ollama precedence) is resolved against
      // a fully-populated model list. Per-provider failures are non-fatal.
      await Promise.allSettled(
        Object.keys(this.providerState)
          .filter((id) => !this.providerState[id].verified && PROVIDERS.some((p) => p.id === id))
          .map((id) => this.verifyProvider(id)),
      );

      // Second pass: now that model lists are populated, re-apply the host
      // preference (it overrides any earlier Ollama auto-pick) and fill any
      // still-unset roles with the ranked default (host/cloud before Ollama).
      this.applyImportedModelPreferences();
      this.autoSelectModels();

      this.hostImporting = false;
      // After host import, ensure we stay on Screen 1 (index 1).
      if (!this.isRerun) this.goToStep(1);
    } catch (e) {
      // Network / unexpected failure — surface it instead of swallowing.
      this.hostImportError =
        'Network error importing providers from this computer: '
        + (e instanceof Error ? e.message : 'unable to reach the server.');
      this.hostImporting = false;
    }
  }

  // ── Reset ─────────────────────────────────────────────────────────────────────

  /**
   * Restore EVERY wizard field to the same default the original
   * component-scoped `$state` had on a fresh mount. Because `setupState` is a
   * module singleton, a second SPA entry to /setup (client-side pushState nav —
   * no full reload, so the module is not re-initialized) would otherwise reopen
   * a STALE wizard (stale step, bypassed system check, stale selections). This
   * runs at the START of `init()` (which fires once per mount) so every mount
   * begins clean; the rerun-prefill and in-flight-deploy pickup in `init()`
   * then re-apply the appropriate non-default state AFTER this reset.
   *
   * NOT to be called mid-flow — only at mount, where there is no in-flight work
   * to clobber (any prior mount's polling/OAuth was already torn down by
   * `dispose()` on unmount; this also defensively tears it down again).
   */
  reset(): void {
    // Tear down any leftover background work first.
    this.stopDeployPolling();
    for (const id of Object.keys(this.oauthAbortControllers)) {
      try { this.oauthAbortControllers[id].abort(); } catch { /* ignore */ }
      delete this.oauthAbortControllers[id];
    }
    this.verifyGeneration = {};

    // Navigation
    this.currentStep = 0;
    this.maxVisitedStep = 0;
    this.showDeploy = false;
    this.systemCheckPassed = false;

    // Model mode + voice toggle
    this.modelMode = 'cloud';
    this.voiceEnabled = false;

    // Step 0
    this.uiLoginPassword = '';
    this.step0Error = '';
    this.autoModeImporting = false;
    this.gpuDetected = false;

    // Step 1
    this.providerState = {};
    this.detectedHostProviders = [];
    this.detectedProviders = [];
    this.opencodeAvailable = false;
    this.opencodeProviders = [];
    this.opencodeAuth = {};
    this.hostProviderCount = 0;
    this.allowEmptyInstall = false;
    this.recommendation = null;
    this.recommendationAlert = '';
    this.recommendationApplied = false;
    this.detectedGpuVramMb = 0;
    this.detectedGpuVendor = '';
    this.detectedGpuName = '';

    // Step 2
    this.modelSelection = {};

    // Step 3 (voice)
    this.voiceTts = { engine: '' };
    this.voiceStt = { engine: '' };
    this.voiceProfiles = [];
    this.selectedVoiceProfile = '';
    this.importedLlmModel = undefined;
    this.importedSmallModel = undefined;

    // Step 4 (options) — fresh portal objects so a prior mount's credentials
    // don't linger (the rerun path mutates these in place).
    this.portalSelection = {
      discord: { enabled: false, botToken: '', applicationId: '' },
      slack: { enabled: false, slackBotToken: '', slackAppToken: '' },
    };
    this.ollamaEnabled = false;
    this.ollamaProfiles = [];
    this.selectedOllamaProfile = '';
    this.imageTag = '';
    this.hostAkmEnabled = false;

    // Step 5 (review + install)
    this.installError = '';
    this.installing = false;
    this.emptyAiAck = false;

    // Deploy
    this.deployData = {};
    this.deployDone = false;
    this.deployHasWarnings = false;
    this.deployError = null;
    this.deployPollErrors = 0;

    // Connect-step row selection
    this.savedCloudLlm = undefined;
    this.detectedCloudConn = '';

    // Host import
    this.hostImportTriggered = false;
    this.hostImporting = false;
    this.hostImportError = '';

    this.isRerun = false;
  }

  // ── Mount: generate token, check status, start discovery ─────────────────────

  init(): void {
    // Start every mount from a clean slate. init() runs once per mount, so a
    // second SPA entry to /setup gets a fresh wizard instead of the singleton's
    // stale state. The rerun-prefill / deploy-pickup below re-apply state AFTER
    // this reset.
    this.reset();
    this.initProviderState();

    const params = new URLSearchParams(window.location.search);
    this.isRerun = params.get('rerun') === '1';

    if (this.isRerun) {
      // Rerun mode: the install is already working, so unlock navigation
      // immediately and pre-fill every step from current config.
      this.systemCheckPassed = true;
      this.maxVisitedStep = 3;
      this.uiLoginPassword = generatePassword(); // fallback; replaced if API returns existing

      fetchCurrentConfig()
        .then((data) => {
          if (!data) return;
          // parseSetupConfig ($lib/setup/payload.ts) is the inverse of the
          // install payload builder — round-trip tested so the two can't drift.
          const parsed = parseSetupConfig(data);
          if (parsed.hostAkmEnabled !== undefined) this.hostAkmEnabled = parsed.hostAkmEnabled;
          if (parsed.llm) this.modelSelection.llm = parsed.llm;
          if (parsed.embedding) this.modelSelection.embedding = parsed.embedding;
          if (parsed.voiceTts) this.voiceTts = parsed.voiceTts;
          if (parsed.voiceStt) this.voiceStt = parsed.voiceStt;
          if (parsed.selectedVoiceProfile) this.selectedVoiceProfile = parsed.selectedVoiceProfile;
          // Restore host-imported model preferences so a rerun keeps the chat /
          // small model the user configured on their host OpenCode.
          if (parsed.importedLlmModel) this.importedLlmModel = parsed.importedLlmModel;
          if (parsed.importedSmallModel) this.importedSmallModel = parsed.importedSmallModel;
          if (parsed.ollamaEnabled) this.ollamaEnabled = true;
          if (parsed.selectedOllamaProfile) this.selectedOllamaProfile = parsed.selectedOllamaProfile;

          // Enabled addons + portal credentials — mutate the existing portal
          // selection objects so credential fields land on reactive state.
          for (const chId of ['discord', 'slack']) {
            const sel = this.portalSelection[chId];
            if (typeof sel === 'object' && sel !== null) {
              if (parsed.enabledAddons.includes(chId)) sel.enabled = true;
              const c = parsed.portalCredentials[chId];
              if (c && typeof c === 'object') Object.assign(sel, c);
            }
          }
        })
        .catch((e) => { console.error('[setup] failed to load existing config:', e); });
    } else {
      this.uiLoginPassword = generatePassword();
      fetchSetupStatus()
        .then((data) => { if (data.setupComplete) window.location.href = '/'; })
        .catch((e) => { console.error('[setup] failed to check setup status:', e); });
    }

    // If a previous deploy is still running (or errored), pick it up
    // without re-triggering /api/setup/complete.
    fetchDeployStatus()
      .then(({ ok, data }) => {
        if (!ok || !data) return;
        if (data.deploying || data.deployError) {
          this.deployData = data;
          this.showDeploy = true;
          this.startDeployPolling();
        }
      })
      .catch((e) => { console.error('[setup] failed to fetch deploy status:', e); });

    void this.loadHostStatus();
    void this.loadVoiceProfiles();
    void this.loadOllamaProfiles();

    this.checkOpenCodeAndInit()
      .then(() => this.detectProviders())
      .catch((e) => { console.error('[setup] provider detection failed:', e); });
  }

  // Tear down background work (deploy polling, in-flight OAuth polls) when the
  // wizard unmounts. The store is a module singleton, so its setInterval /
  // AbortControllers would otherwise outlive the page.
  dispose(): void {
    this.stopDeployPolling();
    for (const id of Object.keys(this.oauthAbortControllers)) {
      try { this.oauthAbortControllers[id].abort(); } catch { /* ignore */ }
      delete this.oauthAbortControllers[id];
    }
  }
}

export const setupState = new SetupState();
