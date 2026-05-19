<script lang="ts">
  import { onMount } from 'svelte';
  import {
    PROVIDERS, LOCAL_PROVIDERS, CHANNELS, KNOWN_EMB_DIMS,
  } from '$lib/wizard/constants.js';
  import type {
    ProviderState, ModelSelection, DetectedProvider, ChannelState,
    OpenCodeProvider, AuthMethod, VoiceEngineValue,
  } from '$lib/wizard/types.js';
  import ProgressBar from './ProgressBar.svelte';
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

  // ── Step 0: Identity ──────────────────────────────────────────────────────
  let adminToken = $state('');
  let ownerName = $state('');
  let ownerEmail = $state('');
  let welcomeHeroDismissed = $state(false);
  let step0Error = $state('');

  // ── Step 1: Providers ─────────────────────────────────────────────────────
  let providerState = $state<Record<string, ProviderState>>({});
  let expandedProvider = $state<string | null>(null);
  let detectedProviders = $state<DetectedProvider[]>([]);
  let detecting = $state(false);
  let opencodeAvailable = $state(false);
  let opencodeProviders = $state<OpenCodeProvider[]>([]);
  let opencodeAuth = $state<Record<string, AuthMethod[]>>({});
  let ocFilterQuery = $state('');
  // Host import detection
  let hostProviderCount = $state(0);
  /** Generation counter per provider — discard stale verify results */
  const verifyGeneration: Record<string, number> = {};

  // ── Step 2: Models ────────────────────────────────────────────────────────
  let modelSelection = $state<{ llm?: ModelSelection; embedding?: ModelSelection; small?: ModelSelection }>({});
  let step2Error = $state('');

  // ── Step 3: Voice ─────────────────────────────────────────────────────────
  // VoiceEngineValue holds engine id + per-engine settings (model/voice/language).
  // Empty engine = not yet chosen; we fall back to voiceDefaults at render time.
  let voiceTts = $state<VoiceEngineValue>({ engine: '' });
  let voiceStt = $state<VoiceEngineValue>({ engine: '' });

  // ── Step 4: Options ───────────────────────────────────────────────────────
  let channelSelection = $state<Record<string, boolean | ChannelState>>({
    chat: true,
    discord: { enabled: false, botToken: '', applicationId: '' },
    slack: { enabled: false, slackBotToken: '', slackAppToken: '' },
  });
  let serviceSelection = $state<Record<string, boolean>>({ admin: true });
  let ollamaEnabled = $state(false);
  let reranking = $state({
    enabled: false,
    mode: 'llm' as 'llm' | 'dedicated',
    model: '',
    topK: 20,
    topN: 5,
  });
  let step4Error = $state('');

  // ── Step 5: Review + Install ──────────────────────────────────────────────
  let installError = $state('');
  let installing = $state(false);

  // ── Deploy screen ─────────────────────────────────────────────────────────
  let deployData = $state<{
    deploying?: boolean;
    setupComplete?: boolean;
    deployStatus?: { service: string; status: string; label?: string }[];
    deployError?: string | null;
  }>({});
  let deployDone = $state(false);
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
      return opencodeProviders
        .filter((p) => providerState[p.id]?.verified)
        .map((p) => {
          const st = providerState[p.id];
          return {
            id: p.id, name: p.name ?? p.id, kind: 'cloud' as const, group: '', order: 0,
            icon: '', desc: '', baseUrl: st?.baseUrl ?? '', llmModel: '',
            embModel: '', embDims: 0,
          };
        });
    }
    return PROVIDERS.filter((p) => providerState[p.id]?.verified);
  });

  const hasOllamaVerified = $derived(
    PROVIDERS.some((p) => p.id === 'ollama' && providerState[p.id]?.verified)
  );

  const hasOpenAI = $derived(
    PROVIDERS.some((p) => p.id === 'openai' && providerState[p.id]?.verified)
  );

  const voiceDefaults = $derived(hasOpenAI
    ? { tts: 'openai-tts', stt: 'openai-stt' }
    : { tts: 'browser-tts', stt: 'browser-stt' });

  const activeTts = $derived(voiceTts.engine || voiceDefaults.tts);
  const activeStt = $derived(voiceStt.engine || voiceDefaults.stt);

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
    if (ollamaEnabled) addons.ollama = true;
    if (serviceSelection.admin) addons.admin = true;

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
      capabilities: {
        llm: llmProvider + '/' + (llm?.model ?? ''),
        embeddings: {
          provider: embProvider,
          model: emb?.model ?? '',
          dims: emb?.dims ?? 1536,
        },
      },
      addons,
      security: { adminToken },
      connections: capabilities,
    };

    if (small?.model) {
      (result.capabilities as Record<string, unknown>).slm = small.connId + '/' + small.model;
    }

    if (reranking.enabled) {
      (result.capabilities as Record<string, unknown>).reranking = {
        enabled: true,
        mode: reranking.mode,
        model: reranking.mode === 'dedicated' ? reranking.model : '',
        topK: reranking.topK || 20,
        topN: reranking.topN || 5,
      };
    }

    // Voice engines — only persist if the user picked something explicit
    // and it isn't the "skip" sentinel.
    const voicePayload = (v: VoiceEngineValue) => {
      if (!v.engine || v.engine.startsWith('skip-')) return undefined;
      const out: Record<string, unknown> = { enabled: true, engine: v.engine };
      if (v.provider) out.provider = v.provider;
      if (v.model) out.model = v.model;
      if (v.voice) out.voice = v.voice;
      if (v.language) out.language = v.language;
      return out;
    };
    const ttsCap = voicePayload(voiceTts);
    if (ttsCap) (result.capabilities as Record<string, unknown>).tts = ttsCap;
    const sttCap = voicePayload(voiceStt);
    if (sttCap) (result.capabilities as Record<string, unknown>).stt = sttCap;

    if (ownerName || ownerEmail) {
      result.owner = {
        name: ownerName || undefined,
        email: ownerEmail || undefined,
      };
    }

    if (Object.keys(channelCredentials).length > 0) {
      result.channelCredentials = channelCredentials;
    }

    return result;
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function generateToken(): string {
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
    if (adminToken.trim().length < 8) {
      step0Error = 'Admin token must be at least 8 characters.';
      return false;
    }
    if (!ownerName.trim()) {
      step0Error = 'Your name is required.';
      return false;
    }
    if (!ownerEmail.trim()) {
      step0Error = 'Email is required.';
      return false;
    }
    step0Error = '';
    return true;
  }

  function validateStep2(): boolean {
    if (!modelSelection.llm?.model) {
      step2Error = 'Select a chat model.';
      return false;
    }
    if (!modelSelection.embedding?.model) {
      step2Error = 'Select an embedding model.';
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
    if (n < 0 || n > 5) return;
    currentStep = n;
    if (n > maxVisitedStep) maxVisitedStep = n;
    showDeploy = false;
    // Auto-select model defaults when entering step 2
    if (n === 2) autoSelectModels();
    // Sync ollamaEnabled from ollamaMode when entering step 4
    if (n === 4 && hasOllamaVerified) {
      ollamaEnabled = providerState.ollama?.ollamaMode === 'instack';
    }
  }

  function autoSelectModels(): void {
    const roles = ['llm', 'embedding'] as const;
    for (const roleId of roles) {
      if (modelSelection[roleId]) continue;
      const options = getModelOptionsForRole(roleId);
      if (options.length === 0) continue;
      const defaultOpt = options.find((o) => o.isDefault) ?? options[0];
      modelSelection[roleId] = { connId: defaultOpt.connId, model: defaultOpt.id, dims: defaultOpt.dims };
    }
    // small model defaults to "same as chat" (no selection)
  }

  function getModelOptionsForRole(roleId: 'llm' | 'embedding' | 'small'): Array<{ id: string; connId: string; isDefault: boolean; dims: number }> {
    const options: Array<{ id: string; connId: string; isDefault: boolean; dims: number }> = [];
    for (const p of verifiedProviders) {
      const st = providerState[p.id];
      const defaultModel = roleId === 'embedding' ? p.embModel : p.llmModel;
      const models = st.models.length > 0 ? st.models : [];

      if (defaultModel && models.includes(defaultModel)) {
        options.push({
          id: defaultModel, connId: p.id, isDefault: true,
          dims: roleId === 'embedding'
            ? (KNOWN_EMB_DIMS[defaultModel] ?? KNOWN_EMB_DIMS[defaultModel.replace(/:.*$/, '')] ?? p.embDims ?? 0)
            : 0,
        });
      }
      for (const m of models) {
        if (m === defaultModel) continue;
        const dims = roleId === 'embedding' ? (KNOWN_EMB_DIMS[m] ?? KNOWN_EMB_DIMS[m.replace(/:.*$/, '')] ?? 0) : 0;
        options.push({ id: m, connId: p.id, isDefault: false, dims });
      }
    }
    if (roleId === 'embedding') {
      const filtered = options.filter((o) => o.isDefault || o.dims > 0);
      if (filtered.length > 0) return filtered;
    }
    return options;
  }

  // ── Provider API calls ────────────────────────────────────────────────────

  async function checkOpenCodeAndInit(): Promise<void> {
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
    }
    providerState = newState;
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
            if (!opencodeAvailable) {
              if (!st.selected) {
                st.selected = true;
                if (dp.provider === 'ollama') st.ollamaMode = 'running';
              }
            }
            if (!opencodeAvailable) void verifyProvider(dp.provider);
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

    const baseUrl = st.baseUrl || p.baseUrl;
    const apiKey = st.apiKey ?? '';

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
    for (let i = 0; i < 120 && st.oauthPolling; i++) {
      await new Promise<void>((r) => setTimeout(r, 5000));
      if (!st.oauthPolling) break;

      try {
        const res = await fetch('/api/setup/opencode/provider/' + encodeURIComponent(providerId) + '/oauth/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: methodIndex }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data) {
          st.verified = true;
          st.error = false;
          st.oauthPolling = false;
          st.verifying = false;
          return;
        }
      } catch {
        // retry
      }
    }

    if (st.oauthPolling) {
      st.oauthPolling = false;
      st.verifying = false;
      st.error = true;
      st.errorMessage = 'Authorization timed out';
    }
  }

  // ── Install & deploy ──────────────────────────────────────────────────────

  async function handleInstall(): Promise<void> {
    if (installing) return;
    installError = '';
    installing = true;

    try {
      const res = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        installError = data.error ?? data.message ?? 'Install failed.';
        installing = false;
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
        if (deployPollErrors >= 3) {
          stopDeployPolling();
          deployData = lastDeployData && lastDeployData.length > 0
            ? { deployStatus: lastDeployData.map((s) => ({ ...s, status: 'running' })) }
            : { deployStatus: [] };
          deployDone = true;
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
        const allRunning = data.deployStatus.every((s: { status: string }) => s.status === 'running');
        if (allRunning) {
          stopDeployPolling();
          deployDone = true;
        }
      } else if (data.setupComplete && !data.deploying && (!data.deployStatus || data.deployStatus.length === 0)) {
        stopDeployPolling();
        deployDone = true;
      }
    } catch {
      deployPollErrors++;
      if (deployPollErrors >= 3) {
        stopDeployPolling();
        if (lastDeployData && lastDeployData.length > 0) {
          deployData = {
            deployStatus: lastDeployData.map((s) => ({ ...s, status: 'running' })),
          };
        } else {
          deployData = { deployStatus: [] };
        }
        deployDone = true;
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

  function handleServiceToggle(id: string): void {
    serviceSelection[id] = !serviceSelection[id];
  }

  function handleSelectModel(role: string, connId: string, modelId: string, dims: number): void {
    modelSelection[role as 'llm' | 'embedding' | 'small'] = { connId, model: modelId, dims };
  }

  function handleSelectNone(role: string): void {
    delete modelSelection[role as 'llm' | 'embedding' | 'small'];
  }

  function handleDeployRetry(): void {
    installing = false;
    deployError = null;
    deployDone = false;
    deployData = {};
    lastDeployData = null;
    deployPollErrors = 0;
    void handleInstall();
  }

  function handleDeployBack(): void {
    installing = false;
    deployError = null;
    deployDone = false;
    deployData = {};
    deployPollErrors = 0;
    lastDeployData = null;
    showDeploy = false;
    currentStep = 5;
  }

  // ── Host import ───────────────────────────────────────────────────────────

  async function loadHostStatus(): Promise<void> {
    try {
      const res = await fetch('/admin/providers/host-status');
      if (res.ok) {
        const data = (await res.json()) as { providerCount: number };
        hostProviderCount = data.providerCount ?? 0;
      }
    } catch {
      // non-critical — import option simply won't appear
    }
  }

  async function handleHostImport(): Promise<void> {
    try {
      const res = await fetch('/admin/providers/import-host', { method: 'POST' });
      if (res.ok) {
        // Import succeeded — advance to models step
        goToStep(2);
      }
    } catch {
      // On failure fall through — user can configure manually
    }
  }

  // ── Mount: generate token, check status, start discovery ─────────────────
  onMount(() => {
    initProviderState();
    adminToken = generateToken();

    fetch('/api/setup/status')
      .then((r) => r.json())
      .then((data) => { if (data.setupComplete) window.location.href = '/'; })
      .catch(() => { /* ignore */ });

    void loadHostStatus();

    checkOpenCodeAndInit()
      .then(() => detectProviders())
      .catch(() => { /* ignore */ });
  });
</script>

<svelte:head>
  <title>OpenPalm Setup</title>
  <link rel="stylesheet" href="/setup/wizard.css">
</svelte:head>

<main class="setup-page" aria-label="Setup wizard">
  <div class="wizard-card">

    <div class="wizard-header">
      <div class="hdr-logo">OP</div>
      <h1>OpenPalm <span class="hdr-suffix">Setup</span></h1>
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

      {#if showDeploy}
        <DeployStep
          {deployData}
          {deployDone}
          {deployError}
          onback={handleDeployBack}
          onretry={handleDeployRetry}
        />
      {:else if currentStep === 0}
        <section class="step-content" id="step-0" data-testid="step-welcome">
          <WelcomeStep
            {adminToken}
            {ownerName}
            {ownerEmail}
            {welcomeHeroDismissed}
            errorMessage={step0Error}
            onadmintoken={(v) => adminToken = v}
            onownername={(v) => ownerName = v}
            onowneremail={(v) => ownerEmail = v}
            ondismisshero={() => { welcomeHeroDismissed = true; }}
            onnext={() => { if (validateStep0()) goToStep(1); }}
          />
        </section>
      {:else if currentStep === 1}
        <section class="step-content" id="step-1" data-testid="step-capabilities">
          <ProvidersStep
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
            onback={() => goToStep(0)}
            onnext={() => { if (verifiedCount > 0) goToStep(2); }}
            ontogglefallback={handleToggleFallback}
            ontoggleopencode={handleToggleOpenCode}
            onverify={handleVerify}
            onapikey={handleApiKey}
            onbaseurl={handleBaseUrl}
            onollamamode={handleOllamaMode}
            onoauthstart={startOpenCodeOAuth}
            onoauthcancel={(id) => { const st = providerState[id]; if (st) { st.oauthPolling = false; st.verifying = false; } }}
            onmarkready={handleMarkReady}
            ondeselect={handleDeselect}
            onfilterchange={(q) => ocFilterQuery = q}
            onhostimport={() => void handleHostImport()}
          />
        </section>
      {:else if currentStep === 2}
        <section class="step-content" id="step-2" data-testid="step-models">
          <ModelsStep
            {verifiedProviders}
            {providerState}
            {modelSelection}
            errorMessage={step2Error}
            onback={() => goToStep(1)}
            onnext={() => { if (validateStep2()) goToStep(3); }}
            onselect={handleSelectModel}
            onselectnone={handleSelectNone}
          />
        </section>
      {:else if currentStep === 3}
        <section class="step-content" id="step-3" data-testid="step-voice">
          <VoiceStep
            tts={voiceTts.engine ? voiceTts : { engine: voiceDefaults.tts }}
            stt={voiceStt.engine ? voiceStt : { engine: voiceDefaults.stt }}
            {hasOpenAI}
            onback={() => goToStep(2)}
            onnext={() => goToStep(4)}
            onchangetts={(v) => voiceTts = v}
            onchangestt={(v) => voiceStt = v}
          />
        </section>
      {:else if currentStep === 4}
        <section class="step-content" id="step-4" data-testid="step-options">
          <OptionsStep
            {channelSelection}
            {serviceSelection}
            hasOllama={hasOllamaVerified}
            {ollamaEnabled}
            {reranking}
            errorMessage={step4Error}
            onback={() => goToStep(3)}
            onnext={() => { if (validateStep4()) goToStep(5); }}
            onchanneltoggle={handleChannelToggle}
            oncredentialchange={handleCredentialChange}
            onservicetoggle={handleServiceToggle}
            onollamaenabledchange={(v) => ollamaEnabled = v}
            onrerankingchange={(updates) => reranking = { ...reranking, ...updates }}
          />
        </section>
      {:else if currentStep === 5}
        <section class="step-content" id="step-5" data-testid="step-review">
          <ReviewStep
            {adminToken}
            {ownerName}
            {ownerEmail}
            {verifiedProviders}
            {modelSelection}
            {activeTts}
            {activeStt}
            {channelSelection}
            {serviceSelection}
            {ollamaEnabled}
            {reranking}
            {payload}
            {installError}
            {installing}
            onback={() => goToStep(4)}
            oninstall={handleInstall}
            ongostepedit={goToStep}
          />
        </section>
      {/if}

    </div>
  </div>
</main>
