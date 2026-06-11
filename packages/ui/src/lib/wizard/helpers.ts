import type { ChannelState, Provider, ProviderState, VoiceEngineValue } from './types.js';
import { KNOWN_EMB_DIMS } from './constants.js';

// Compose addon hardware-profile id. Inlined (NOT imported from @openpalm/lib):
// this module is reachable from client-side wizard components, and importing the
// server library here drags its whole runtime (node:fs / child_process / class
// hierarchy) into the browser bundle — which crashes the wizard with
// "Class extends value undefined" (the rc.2 regression). Keep it literal.
function addonProfileId(addon: string, variant: 'cpu' | 'cuda' | 'rocm'): string {
  return `addon.${addon}.${variant}`;
}

// ── Shared GPU-aware addon hardware-profile selection ────────────────────────
// One implementation for voice/ollama profile picking, previously copy-pasted
// across loadVoiceProfiles / handleEnableVoiceChange / handleInstall / the
// Ollama enable path (each could drift). Prefers the requested variant (or CUDA
// when a GPU was detected, else CPU), then the addon's default, then CPU, then
// any available profile. Returns the chosen profile id, or undefined when none
// is available.
type SelectableProfile = { id: string; available?: boolean; default?: boolean };

export function selectAddonProfileId(
  profiles: SelectableProfile[],
  addon: string,
  gpuDetected: boolean,
  variant?: 'cpu' | 'cuda' | 'rocm',
): string | undefined {
  const avail = (p: SelectableProfile) => p.available !== false;
  const preferred = addonProfileId(addon, variant ?? (gpuDetected ? 'cuda' : 'cpu'));
  const cpu = addonProfileId(addon, 'cpu');
  return (
    profiles.find((p) => p.id === preferred && avail(p))
    ?? profiles.find((p) => p.default && avail(p))
    ?? profiles.find((p) => p.id === cpu && avail(p))
    ?? profiles.find((p) => avail(p))
  )?.id;
}

// ── Shared model-option building (used by the wizard page + Models step) ─────
// Single source of truth for turning detected provider models into role options
// (chat / small / embedding). Keeping ONE implementation prevents the two call
// sites from drifting (they previously each offered embedding models as chat
// candidates and ranked by arbitrary list order — bug #3 / #460).

/** Strip an Ollama-style ":tag" suffix so "llama3.2" matches "llama3.2:latest". */
export function baseModelId(model: string): string {
  return model.replace(/:.*$/, '');
}

/** True for embedding models — never offered/auto-picked for the chat/small role. */
export function isEmbeddingModelId(model: string): boolean {
  const base = baseModelId(model);
  if (KNOWN_EMB_DIMS[model] !== undefined || KNOWN_EMB_DIMS[base] !== undefined) return true;
  return /(?:^|[-/_.])(embed|embedding|bge|gte|e5|nomic|mxbai|arctic-embed|minilm)/i.test(model);
}

/** Heuristic score for a chat ('llm') or 'small' model. Higher = better default. */
export function scoreModelForRole(roleId: 'llm' | 'small', model: string): number {
  const m = model.toLowerCase();
  let s = 0;
  if (/instruct|chat|-it\b|\bit\b/.test(m)) s += 30; // tuned for conversation
  if (/coder|code/.test(m)) s += 8;                  // capable general models too
  const sizeMatch = m.match(/(\d+(?:\.\d+)?)\s*x?\s*b\b/); // 7b, 70b, 3.2b…
  const sizeB = sizeMatch ? parseFloat(sizeMatch[1]) : 0;
  if (roleId === 'llm') s += Math.min(40, sizeB);          // chat: bigger is better
  else s += Math.max(0, 20 - Math.min(20, sizeB));         // small: smaller is better
  return s;
}

export type RoleModelOption = {
  id: string;
  connId: string;
  providerName: string;
  baseUrl: string;
  isDefault: boolean;
  dims: number;
};

// Local provider ids whose models rank AFTER host/cloud providers for chat/small
// auto-selection: an imported host OpenCode provider (or a cloud key) should win
// over the bundled in-stack Ollama for the default chat model (bug #4).
const LOCAL_PROVIDER_IDS = new Set(['ollama', 'lmstudio', 'model-runner']);

/**
 * Build the ranked list of model options for a role across all verified
 * providers. For chat/small: embedding models are excluded and results are
 * ordered best-first (host/cloud before local, provider's declared default,
 * then the role heuristic) so options[0] is the sensible auto-pick. For
 * embedding: only real embedding models are returned (may be empty — akm
 * self-embeds locally, so an empty list is fine and the role is auto-handled).
 */
export function buildModelOptions(
  roleId: 'llm' | 'embedding' | 'small',
  verifiedProviders: Provider[],
  providerState: Record<string, ProviderState>,
): RoleModelOption[] {
  const options: RoleModelOption[] = [];
  for (const p of verifiedProviders) {
    const st = providerState[p.id];
    if (!st) continue;
    const defaultModel = roleId === 'embedding' ? p.embModel : p.llmModel;
    const models = st.models.length > 0 ? st.models : [];
    // Tag-insensitive default match: the static default ("llama3.2") rarely
    // equals the installed tag ("llama3.2:latest"), so compare base names.
    const matchedDefault = defaultModel
      ? models.find((m) => m === defaultModel || baseModelId(m) === baseModelId(defaultModel))
      : undefined;

    for (const m of models) {
      if (roleId !== 'embedding' && isEmbeddingModelId(m)) continue;
      const dims = roleId === 'embedding'
        ? (KNOWN_EMB_DIMS[m] ?? KNOWN_EMB_DIMS[baseModelId(m)] ?? (m === matchedDefault ? p.embDims : 0) ?? 0)
        : 0;
      options.push({
        id: m, connId: p.id, providerName: p.name, baseUrl: st.baseUrl || p.baseUrl,
        isDefault: m === matchedDefault, dims,
      });
    }
  }

  if (roleId === 'embedding') {
    return options.filter((o) => o.isDefault || o.dims > 0);
  }

  return options.sort((a, b) =>
    (LOCAL_PROVIDER_IDS.has(a.connId) ? 1 : 0) - (LOCAL_PROVIDER_IDS.has(b.connId) ? 1 : 0)
    || (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0)
    || scoreModelForRole(roleId, b.id) - scoreModelForRole(roleId, a.id),
  );
}

/**
 * Resolve which voice engine to use for one side (TTS or STT).
 *
 * - An explicit engine in `side` wins unconditionally.
 * - No explicit engine + bundled voice enabled → openpalm-voice.
 * - No explicit engine + bundled voice off → fallback engine (e.g. 'browser-tts').
 *
 * Pass fallbackEngine='' for the "persisted" form (nothing saved when untouched).
 * Pass a concrete fallback for the "displayed" form so the UI shows the real default.
 */
export function resolveVoiceSide(side: VoiceEngineValue, enableVoice: boolean, fallbackEngine: string): VoiceEngineValue {
  if (side.engine) return side;
  if (enableVoice) return { engine: 'openpalm-voice' };
  return { engine: fallbackEngine };
}

export function isChannelEnabled(channelSelection: Record<string, boolean | ChannelState>, chId: string, locked?: boolean): boolean {
  if (locked) return true;
  const sel = channelSelection[chId];
  if (typeof sel === 'object' && sel !== null) return sel.enabled;
  return !!sel;
}

export function getCredValue(channelSelection: Record<string, boolean | ChannelState>, chId: string, key: string): string {
  const sel = channelSelection[chId];
  if (typeof sel === 'object' && sel !== null) return String(sel[key] ?? '');
  return '';
}
