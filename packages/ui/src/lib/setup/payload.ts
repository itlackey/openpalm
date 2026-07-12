import type { ModelSelection, PortalState, Provider, ProviderState, VoiceEngineValue } from '../client/types.js';
import { buildPortalsConfig } from '../client/helpers.js';
import { isNetworkAccessPreset, type NetworkAccessPreset } from '@openpalm/lib/control-plane/network-preset.js';

// ── Install payload contract (POST /api/setup/complete) ──────────────────────
// The pure builder + inverse parser for the setup install contract. Extracted
// from setup/+page.svelte so the assembly rules (capability selection, addon
// suppression, voice serialization, portal-credential flattening) are testable
// and can't silently drift from the rerun deserializer (parseSetupConfig).

/** One connection entry sent under `connections`. */
export interface SetupCapability {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
}

/** Serialized voice engine block (tts/stt). Omitted entirely when not chosen. */
export interface SetupVoicePayload {
  enabled: true;
  engine: string;
  provider?: string;
  baseURL?: string;
  model?: string;
  voice?: string;
  language?: string;
  apiKey?: string;
}

/** The full install payload posted to /api/setup/complete. */
export interface SetupPayload {
  version: 2;
  addons: Record<string, boolean>;
  security: { uiLoginPassword: string };
  connections: SetupCapability[];
  llm?: { provider: string; model: string; baseUrl: string };
  embedding?: { provider: string; model: string; dims: number; baseUrl: string };
  tts?: SetupVoicePayload;
  stt?: SetupVoicePayload;
  voiceProfile?: string;
  ollamaProfile?: string;
  portalCredentials?: Record<string, Record<string, string>>;
  imageTag?: string;
  hostAkm?: boolean;
  /** #563 — network access preset. Omitted entirely on a rerun the operator didn't touch (D7). */
  network?: { preset: NetworkAccessPreset; opencodePassword?: string };
}

/** Everything buildSetupPayload needs — the resolved wizard state at install time. */
export interface SetupPayloadInput {
  modelSelection: { llm?: ModelSelection; embedding?: ModelSelection; small?: ModelSelection };
  verifiedProviders: Provider[];
  providerState: Record<string, ProviderState>;
  ollamaEnabled: boolean;
  /** A host Ollama/LM Studio is running — suppresses the redundant in-stack Ollama addon. */
  hostLocalLlmRunning: boolean;
  /** Resolved (persisted-form) voice sides — '' engine means "don't save this side". */
  persistedVoiceTts: VoiceEngineValue;
  persistedVoiceStt: VoiceEngineValue;
  selectedVoiceProfile: string;
  selectedOllamaProfile: string;
  portalSelection: Record<string, boolean | PortalState>;
  uiLoginPassword: string;
  imageTag: string;
  hostAkmEnabled: boolean;
  /** #563 — chosen network access preset; null means "don't touch network config" (rerun over a custom/undetected env, D7). */
  networkPreset: NetworkAccessPreset | null;
  /** Password for the home-password preset; ignored (never sent) by every other preset. */
  opencodePassword: string;
}

/** Serialize one voice side, or undefined when not chosen / a "skip-" sentinel. */
function voicePayload(v: VoiceEngineValue): SetupVoicePayload | undefined {
  if (!v.engine || v.engine.startsWith('skip-')) return undefined;
  const out: SetupVoicePayload = { enabled: true, engine: v.engine };
  if (v.provider) out.provider = v.provider;
  if (v.baseURL) out.baseURL = v.baseURL;
  if (v.model) out.model = v.model;
  if (v.voice) out.voice = v.voice;
  if (v.language) out.language = v.language;
  if (v.apiKey) out.apiKey = v.apiKey;
  return out;
}

/**
 * Build the install payload for /api/setup/complete from resolved wizard state.
 *
 * Pure — no reactivity, no fetch. Mirrors the former `payload` $derived exactly:
 *  - capabilities: verified providers referenced by the selected llm/emb/small.
 *  - addons: in-stack Ollama (suppressed when a host runtime is running), the
 *    bundled voice addon (when either side targets openpalm-voice), and portals.
 *  - llm/embedding go directly to akm config; voice sides only when explicit.
 */
export function buildSetupPayload(input: SetupPayloadInput): SetupPayload {
  const {
    modelSelection, verifiedProviders, providerState, ollamaEnabled, hostLocalLlmRunning,
    persistedVoiceTts, persistedVoiceStt, selectedVoiceProfile, selectedOllamaProfile,
    portalSelection, uiLoginPassword, imageTag, hostAkmEnabled, networkPreset, opencodePassword,
  } = input;

  const llm = modelSelection.llm;
  const emb = modelSelection.embedding;
  const small = modelSelection.small;

  const capabilityProviderIds: Record<string, boolean> = {};
  if (llm) capabilityProviderIds[llm.connId] = true;
  if (emb) capabilityProviderIds[emb.connId] = true;
  if (small?.model) capabilityProviderIds[small.connId] = true;

  const capabilities: SetupCapability[] = verifiedProviders
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
  // Suppress the in-stack Ollama addon when a host Ollama/LM Studio is running.
  if (ollamaEnabled && !hostLocalLlmRunning) addons.ollama = true;
  // Enable the bundled voice addon when either side targets it.
  if (persistedVoiceTts.engine === 'openpalm-voice' || persistedVoiceStt.engine === 'openpalm-voice') {
    addons.voice = true;
  }

  const portalCredentials: Record<string, Record<string, string>> = {};
  const portalsConfig = buildPortalsConfig(portalSelection);
  for (const chId of Object.keys(portalsConfig)) {
    const chVal = portalsConfig[chId];
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
      if (Object.keys(creds).length > 0) portalCredentials[chId] = creds;
    }
  }

  const result: SetupPayload = {
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

  // Voice engines — only persist an explicit, non-"skip" side.
  const ttsCap = voicePayload(persistedVoiceTts);
  if (ttsCap) result.tts = ttsCap;
  const sttCap = voicePayload(persistedVoiceStt);
  if (sttCap) result.stt = sttCap;

  // Hardware profile for the bundled voice addon.
  if ((persistedVoiceTts.engine === 'openpalm-voice' || persistedVoiceStt.engine === 'openpalm-voice') && selectedVoiceProfile) {
    result.voiceProfile = selectedVoiceProfile;
  }

  // Ollama hardware profile when Ollama is enabled in-stack.
  if (ollamaEnabled && selectedOllamaProfile) {
    result.ollamaProfile = selectedOllamaProfile;
  }

  if (Object.keys(portalCredentials).length > 0) {
    result.portalCredentials = portalCredentials;
  }

  if (imageTag.trim()) result.imageTag = imageTag.trim();
  if (hostAkmEnabled) result.hostAkm = true;

  // #563 — network access preset. null (rerun over a custom/undetected env
  // the operator hasn't touched) omits the field entirely (D7); only
  // home-password carries a password (D5/D7 — the other presets REJECT one).
  if (networkPreset !== null) {
    result.network = networkPreset === 'home-password'
      ? { preset: networkPreset, opencodePassword }
      : { preset: networkPreset };
  }

  return result;
}

// ── Inverse: parse GET /api/setup/current-config for wizard rerun pre-fill ────

/** Shape of the current-config response consumed by parseSetupConfig. */
export interface RawSetupConfig {
  hostAkm?: unknown;
  llm?: { provider?: string; model?: string } | null;
  embedding?: { provider?: string; model?: string; dims?: number } | null;
  voice?: {
    tts?: { engine?: string; baseURL?: string; model?: string; voice?: string } | null;
    stt?: { engine?: string; baseURL?: string; model?: string; language?: string } | null;
    selectedProfile?: unknown;
  } | null;
  importedModelPreferences?: { model?: string; small_model?: string } | null;
  enabledAddons?: unknown;
  ollama?: { selectedProfile?: unknown } | null;
  portalCredentials?: Record<string, Record<string, unknown>> | null;
  /** #563 — the detected network access preset (null = custom/hand-tuned). */
  network?: { preset?: string | null } | null;
}

/**
 * Partial wizard state reconstructed from a stored install (rerun pre-fill).
 * Fields are only present when the stored config supplies them, so the caller
 * applies them non-destructively over its current reactive state.
 */
export interface PartialSetupState {
  hostAkmEnabled?: boolean;
  llm?: ModelSelection;
  embedding?: ModelSelection;
  voiceTts?: VoiceEngineValue;
  voiceStt?: VoiceEngineValue;
  selectedVoiceProfile?: string;
  importedLlmModel?: string;
  importedSmallModel?: string;
  ollamaEnabled?: boolean;
  selectedOllamaProfile?: string;
  /** Enabled addon ids (portals + ollama) — the caller maps portals to selection. */
  enabledAddons: string[];
  /** Raw per-portal credential metadata, applied onto the portal selection as-is. */
  portalCredentials: Record<string, Record<string, unknown>>;
  /**
   * #563 — the detected network access preset for rerun pre-fill. Unset when
   * the response has no `network` field at all; `null` when present but the
   * preset is absent/unrecognized (custom/hand-tuned env, D7/D8).
   */
  networkPreset?: NetworkAccessPreset | null;
}

/**
 * Parse the current-config response into a PartialSetupState for rerun pre-fill.
 *
 * The inverse of buildSetupPayload: keeps the two directions from drifting on
 * field semantics (llm/embedding/voice engines/profiles/addons/portals). Mirrors
 * the former inline rerun parser in setup/+page.svelte. Pure — no side effects.
 */
export function parseSetupConfig(data: RawSetupConfig): PartialSetupState {
  const result: PartialSetupState = { enabledAddons: [], portalCredentials: {} };

  if (typeof data.hostAkm === 'boolean') result.hostAkmEnabled = data.hostAkm;

  // Models — store saved selections; the connId resolves once the matching
  // provider is verified by the host-import / OpenCode flow.
  if (data.llm?.provider && data.llm?.model) {
    result.llm = { connId: data.llm.provider, model: data.llm.model };
  }
  if (data.embedding?.provider && data.embedding?.model) {
    result.embedding = {
      connId: data.embedding.provider,
      model: data.embedding.model,
      dims: data.embedding.dims,
    };
  }

  // Voice — pre-fill connection fields only when the stored config explicitly
  // names the engine. No URL sniffing.
  if (data.voice?.tts) {
    const storedTts = data.voice.tts;
    result.voiceTts = storedTts.engine ? { ...storedTts, engine: storedTts.engine } : { engine: '' };
  }
  if (data.voice?.stt) {
    const storedStt = data.voice.stt;
    result.voiceStt = storedStt.engine ? { ...storedStt, engine: storedStt.engine } : { engine: '' };
  }
  if (data.voice?.selectedProfile && typeof data.voice.selectedProfile === 'string') {
    result.selectedVoiceProfile = data.voice.selectedProfile;
  }

  // Restore host-imported model preferences so a rerun keeps the chat/small model.
  const imp = data.importedModelPreferences;
  if (imp?.model) result.importedLlmModel = imp.model;
  if (imp?.small_model) result.importedSmallModel = imp.small_model;

  // Enabled addons + portal credentials
  const enabled: string[] = Array.isArray(data.enabledAddons) ? (data.enabledAddons as string[]) : [];
  result.enabledAddons = enabled;
  if (enabled.includes('ollama')) result.ollamaEnabled = true;
  if (data.ollama?.selectedProfile && typeof data.ollama.selectedProfile === 'string') {
    result.selectedOllamaProfile = data.ollama.selectedProfile;
  }
  result.portalCredentials = data.portalCredentials ?? {};

  // #563 — network access preset (D7/D8). Only set the field when the
  // response carries a `network` key at all; an unrecognized/absent preset
  // inside it maps to null (custom/hand-tuned env), never a garbage passthrough.
  if (data.network !== undefined && data.network !== null) {
    const preset = data.network.preset;
    result.networkPreset = isNetworkAccessPreset(preset) ? preset : null;
  }

  return result;
}
