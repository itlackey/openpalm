import type { ModelSelection, OpenCodeProvider, PortalState, Provider, ProviderState, VoiceEngineValue } from './types.js';
import { PORTALS, PROVIDERS } from './constants.js';
import { addonProfileId, KNOWN_EMBEDDING_MODEL_DIMS } from '@openpalm/lib/provider-constants';
import { LOCAL_PROVIDER_IDS } from './constants.js';

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
  if (KNOWN_EMBEDDING_MODEL_DIMS[model] !== undefined || KNOWN_EMBEDDING_MODEL_DIMS[base] !== undefined) return true;
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

// LOCAL_PROVIDER_IDS (imported from ./constants) are the "runs on this computer"
// runtimes whose models rank AFTER host/cloud providers for chat/small
// auto-selection: an imported host OpenCode provider (or a cloud key) should win
// over the bundled in-stack Ollama for the default chat model (bug #4).

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
        ? (KNOWN_EMBEDDING_MODEL_DIMS[m] ?? KNOWN_EMBEDDING_MODEL_DIMS[baseModelId(m)] ?? (m === matchedDefault ? p.embDims : 0) ?? 0)
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

export function isPortalEnabled(portalSelection: Record<string, boolean | PortalState>, chId: string, locked?: boolean): boolean {
  if (locked) return true;
  const sel = portalSelection[chId];
  if (typeof sel === 'object' && sel !== null) return sel.enabled;
  return !!sel;
}

export function getCredValue(portalSelection: Record<string, boolean | PortalState>, chId: string, key: string): string {
  const sel = portalSelection[chId];
  if (typeof sel === 'object' && sel !== null) return String(sel[key] ?? '');
  return '';
}

// ── Random UI-login password ─────────────────────────────────────────────────
/** 32-hex-char (128-bit) random password used as the OP_UI_LOGIN_PASSWORD default. */
export function generatePassword(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Portals config assembly ──────────────────────────────────────────────────
/**
 * Collapse the wizard's `portalSelection` state into the enabled-portals config
 * consumed by the install payload. Locked portals (e.g. the API endpoint) are
 * always `true`; toggled portals with credentials become `{ enabled, ...creds }`;
 * a plain-boolean selection becomes `true`. Disabled portals are omitted.
 */
export function buildPortalsConfig(
  portalSelection: Record<string, boolean | PortalState>,
): Record<string, boolean | Record<string, string | boolean>> {
  const result: Record<string, boolean | Record<string, string | boolean>> = {};
  for (const ch of PORTALS) {
    const sel = portalSelection[ch.id];
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

// ── Verified-provider list ───────────────────────────────────────────────────
/**
 * Build the list of verified providers used to assemble capabilities/models.
 *
 * When OpenCode is available: start from the verified OpenCode providers
 * (inheriting llmModel/embModel/embDims from the static fallback for local
 * providers), then append any verified static providers not already in the
 * OpenCode list (e.g. Ollama added by the wizard's "Include Ollama" toggle).
 * When OpenCode is unavailable: just the verified static providers.
 */
export function buildVerifiedProviders(
  opencodeAvailable: boolean,
  opencodeProviders: OpenCodeProvider[],
  providerState: Record<string, ProviderState>,
): Provider[] {
  if (opencodeAvailable) {
    const fromOpenCode: Provider[] = opencodeProviders
      .filter((p) => providerState[p.id]?.verified)
      .map((p) => {
        const st = providerState[p.id];
        const fallback = PROVIDERS.find((fp) => fp.id === p.id);
        return {
          id: p.id, name: p.name ?? p.id, kind: 'cloud' as const, group: '', order: 0,
          icon: '', desc: '', baseUrl: st?.baseUrl ?? '',
          llmModel: fallback?.llmModel ?? '',
          embModel: fallback?.embModel ?? '',
          embDims: fallback?.embDims ?? 0,
        };
      });
    const openCodeIds = new Set(fromOpenCode.map((p) => p.id));
    const fromStatic: Provider[] = PROVIDERS
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
}

// ── Auto model selection ─────────────────────────────────────────────────────
/**
 * Fill any unset chat ('llm') / 'small' role with the best-ranked option from
 * the verified providers. Embedding is never auto-selected — akm self-embeds
 * locally, so the wizard leaves it unset unless the user picks one explicitly.
 * Returns a NEW selection object; already-set roles are preserved untouched.
 */
export function computeAutoModelSelection(
  current: { llm?: ModelSelection; embedding?: ModelSelection; small?: ModelSelection },
  verifiedProviders: Provider[],
  providerState: Record<string, ProviderState>,
): { llm?: ModelSelection; embedding?: ModelSelection; small?: ModelSelection } {
  const next = { ...current };
  const roles = ['llm', 'embedding', 'small'] as const;
  for (const roleId of roles) {
    if (next[roleId]) continue;
    if (roleId === 'embedding') continue;
    const options = buildModelOptions(roleId, verifiedProviders, providerState);
    if (options.length === 0) continue;
    // options are best-first, so options[0] is the sensible pick.
    const best = options[0];
    next[roleId] = { connId: best.connId, model: best.id, dims: best.dims };
  }
  return next;
}

// ── Preferred (host/imported) model resolution ───────────────────────────────
/**
 * Resolve an imported host preference (e.g. "github-copilot/gpt-5.4") to a
 * concrete selection using a 4-tier match against the role's options:
 *   1. exact full id ("openai/gpt-4o")
 *   2. provider-hint + model-name-part
 *   3. model-name-part alone
 *   4. offline fallback: provider verified but model list not yet loaded —
 *      trust the host preference directly rather than dropping it (#5).
 * Returns undefined when nothing matches (or no preference given).
 */
export function resolvePreferredModelSelection(
  roleId: 'llm' | 'small',
  preferredModel: string | undefined,
  verifiedProviders: Provider[],
  providerState: Record<string, ProviderState>,
): ModelSelection | undefined {
  if (!preferredModel) return undefined;

  const slashIdx = preferredModel.indexOf('/');
  const providerHint = slashIdx > 0 ? preferredModel.slice(0, slashIdx) : '';
  const modelIdPart = slashIdx > 0 ? preferredModel.slice(slashIdx + 1) : preferredModel;

  const options = buildModelOptions(roleId, verifiedProviders, providerState);

  const exactFull = options.find((o) => o.id === preferredModel);
  if (exactFull) return { connId: exactFull.connId, model: exactFull.id, dims: exactFull.dims };

  const providerMatch = providerHint
    ? options.find((o) => o.connId === providerHint && o.id === modelIdPart)
    : undefined;
  if (providerMatch) return { connId: providerMatch.connId, model: providerMatch.id, dims: providerMatch.dims };

  const nameMatch = options.find((o) => o.id === modelIdPart);
  if (nameMatch) return { connId: nameMatch.connId, model: nameMatch.id, dims: nameMatch.dims };

  if (providerHint && verifiedProviders.some((p) => p.id === providerHint)) {
    return { connId: providerHint, model: modelIdPart, dims: 0 };
  }

  return undefined;
}
