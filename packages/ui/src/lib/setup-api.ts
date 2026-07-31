import type { SetupRecommendation } from '@openpalm/lib';
import type { VoiceAddonProfile } from './api.js';
import type { AuthMethod, DetectedProvider, OpenCodeProvider } from './client/types.js';
import type { RawSetupConfig, SetupPayload } from './setup/payload.js';

// ── Typed data-access for the setup wizard (/api/setup/*) ────────────────────
// Mirrors the structure of $lib/api.ts (a shared request primitive + one typed
// function per endpoint with response DTOs). It deliberately uses a setup-local
// `setupRequest` rather than api.ts's `request`: the setup endpoints are
// unauthenticated during install and the inline fetches sent NO credentials and
// NO x-request-id/x-requested-by headers — only a Content-Type when a body is
// present. Reusing api.ts's request verbatim would change every request's
// headers, so this preserves the exact wire behavior. Per-endpoint error
// handling matches each original call site (some throw a server message, some
// return { ok, data } so the caller can read a structured failure body, some
// return null when the response wasn't usable).

const SETUP_BASE = '/api/setup';

async function setupRequest(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  if (signal) init.signal = signal;
  return fetch(`${SETUP_BASE}${path}`, init);
}

/** Response carrying both the HTTP ok flag and the parsed body, for endpoints
 *  whose caller branches on `res.ok` AND a structured `{ ok, message }` body. */
export interface SetupApiResult<T> {
  ok: boolean;
  data: T;
}

// ── Addon hardware profiles ──────────────────────────────────────────────────

export interface AddonProfilesResponse {
  ok?: boolean;
  profiles?: VoiceAddonProfile[];
  selectedProfile?: string | null;
}

/** GET /voice-profiles — null when the response was not ok. */
export async function fetchVoiceProfiles(): Promise<AddonProfilesResponse | null> {
  const res = await setupRequest('GET', '/voice-profiles');
  if (!res.ok) return null;
  return (await res.json()) as AddonProfilesResponse;
}

/** GET /ollama-profiles — null when the response was not ok. */
export async function fetchOllamaProfiles(): Promise<AddonProfilesResponse | null> {
  const res = await setupRequest('GET', '/ollama-profiles');
  if (!res.ok) return null;
  return (await res.json()) as AddonProfilesResponse;
}

// ── Recommendation ───────────────────────────────────────────────────────────

export interface RecommendResponse {
  ok?: boolean;
  recommendation?: SetupRecommendation;
  hostProviders?: { provider: string; url: string }[];
  gpu?: { vramMb?: number; vendor?: string; name?: string } | null;
  cloudProviders?: string[];
}

/** GET /recommend — null when the response was not ok. */
export async function fetchRecommendation(): Promise<RecommendResponse | null> {
  const res = await setupRequest('GET', '/recommend');
  if (!res.ok) return null;
  return (await res.json()) as RecommendResponse;
}

// ── OpenCode ─────────────────────────────────────────────────────────────────

// W1: `url`/`started` were dropped from this type even though the server
// always sends them — carried through now so callers that need the resolved
// wizard-instance URL (rather than just the `ok` flag) can read it.
export interface OpenCodeEnsureResponse { ok: boolean; url?: string; started?: boolean; }
export interface OpenCodeStatusResponse { available?: boolean; }
export interface OpenCodeProvidersResponse {
  available?: boolean;
  providers?: OpenCodeProvider[];
  auth?: Record<string, AuthMethod[]>;
  connected?: string[];
  selectedModels?: { llm?: string; small?: string };
}

/** POST /opencode/ensure — null when the response was not ok. */
export async function ensureOpenCode(): Promise<OpenCodeEnsureResponse | null> {
  const res = await setupRequest('POST', '/opencode/ensure');
  if (!res.ok) return null;
  return (await res.json()) as OpenCodeEnsureResponse;
}

/** GET /opencode/status — null when the response was not ok. */
export async function fetchOpenCodeStatus(): Promise<OpenCodeStatusResponse | null> {
  const res = await setupRequest('GET', '/opencode/status');
  if (!res.ok) return null;
  return (await res.json()) as OpenCodeStatusResponse;
}

/** GET /opencode/providers — null when the response was not ok. */
export async function fetchOpenCodeProviders(): Promise<OpenCodeProvidersResponse | null> {
  const res = await setupRequest('GET', '/opencode/providers');
  if (!res.ok) return null;
  return (await res.json()) as OpenCodeProvidersResponse;
}

// ── Provider detection & model listing ───────────────────────────────────────

export interface DetectProvidersResponse { providers?: DetectedProvider[]; }

/** GET /detect-providers — null when the response was not ok. */
export async function fetchDetectedProviders(): Promise<DetectProvidersResponse | null> {
  const res = await setupRequest('GET', '/detect-providers');
  if (!res.ok) return null;
  return (await res.json()) as DetectProvidersResponse;
}

export interface ProviderModelsResponse {
  models: string[];
  status?: string;
  error?: string;
}

/**
 * POST /models/:provider — list models for a provider connection.
 * Throws with the server's `error` (or an HTTP fallback) on a non-ok response
 * OR a 200 body with status === 'recoverable_error'.
 */
export async function fetchProviderModels(
  provider: string,
  input: { apiKey: string; baseUrl: string },
): Promise<ProviderModelsResponse> {
  const res = await setupRequest('POST', `/models/${encodeURIComponent(provider)}`, {
    apiKey: input.apiKey ?? '', baseUrl: input.baseUrl ?? '',
  });
  const data = (await res.json()) as ProviderModelsResponse;
  if (!res.ok || data.status === 'recoverable_error') {
    throw new Error(data.error ?? `Failed to fetch models (HTTP ${res.status})`);
  }
  return data;
}

// ── OpenCode OAuth ───────────────────────────────────────────────────────────

export interface OAuthAuthorizeResponse {
  url?: string;
  method?: 'auto' | 'code';
  instructions?: string;
  message?: string;
}

/** POST /opencode/provider/:id/oauth/authorize — throws the server message on non-ok. */
export async function authorizeOpenCodeOAuth(
  providerId: string,
  methodIndex: number,
): Promise<OAuthAuthorizeResponse> {
  const res = await setupRequest(
    'POST', `/opencode/provider/${encodeURIComponent(providerId)}/oauth/authorize`, { method: methodIndex },
  );
  const data = (await res.json()) as OAuthAuthorizeResponse;
  if (!res.ok) throw new Error(data.message ?? 'OAuth failed');
  return data;
}

export interface OAuthCallbackResponse { ok?: boolean; message?: string; }

/**
 * POST /opencode/provider/:id/oauth/callback — the long-poll callback (caller
 * supplies the combined abort/timeout signal). Returns { ok, data }; `data` is
 * null when the body couldn't be parsed. Network/abort errors propagate so the
 * caller can distinguish user-cancel from timeout.
 */
export async function pollOpenCodeOAuthCallback(
  providerId: string,
  methodIndex: number,
  signal: AbortSignal,
): Promise<SetupApiResult<OAuthCallbackResponse | null>> {
  const res = await setupRequest(
    'POST', `/opencode/provider/${encodeURIComponent(providerId)}/oauth/callback`, { method: methodIndex }, signal,
  );
  const data = (await res.json().catch(() => null)) as OAuthCallbackResponse | null;
  return { ok: res.ok, data };
}

// ── Install & deploy ─────────────────────────────────────────────────────────

export interface SetupCompleteResponse {
  ok?: boolean;
  message?: string;
  error?: string;
}

/** POST /complete — returns { ok, data }; `data` is {} when the body can't parse. */
export async function completeSetup(payload: SetupPayload): Promise<SetupApiResult<SetupCompleteResponse>> {
  const res = await setupRequest('POST', '/complete', payload);
  const data = (await res.json().catch(() => ({}))) as SetupCompleteResponse;
  return { ok: res.ok, data };
}

export interface DeployStatusResponse {
  deploying?: boolean;
  setupComplete?: boolean;
  deployStatus?: { service: string; status: string; label?: string }[];
  deployError?: string | null;
  ports?: { admin?: number; ui?: number; assistant?: number };
}

/** GET /deploy-status — returns { ok, data }; `data` is null when not ok. */
export async function fetchDeployStatus(): Promise<SetupApiResult<DeployStatusResponse | null>> {
  const res = await setupRequest('GET', '/deploy-status');
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: (await res.json()) as DeployStatusResponse };
}

export interface RetryDeployResponse { ok?: boolean; message?: string; }

/** POST /retry-deploy — returns { ok, data }; `data` is {} when the body can't parse. */
export async function retryDeploy(): Promise<SetupApiResult<RetryDeployResponse>> {
  const res = await setupRequest('POST', '/retry-deploy');
  const data = (await res.json().catch(() => ({}))) as RetryDeployResponse;
  return { ok: res.ok, data };
}

// ── Host import ──────────────────────────────────────────────────────────────

export interface HostStatusResponse {
  providerCount: number;
  credentialCount?: number;
  modelPreferences?: { model?: string; small_model?: string };
  imageTag?: string;
  hostAkmAvailable?: boolean;
  warning?: string;
}

/** GET /host-status — null when the response was not ok. */
export async function fetchHostStatus(): Promise<HostStatusResponse | null> {
  const res = await setupRequest('GET', '/host-status');
  if (!res.ok) return null;
  return (await res.json()) as HostStatusResponse;
}

export interface ImportHostResponse {
  ok?: boolean;
  error?: string;
  importedProviders?: string[];
  pushedProviders?: string[];
}

/** POST /import-host — returns { ok, data }; `data` is null when the body can't parse. */
export async function importHost(): Promise<SetupApiResult<ImportHostResponse | null>> {
  const res = await setupRequest('POST', '/import-host');
  const data = (await res.json().catch(() => null)) as ImportHostResponse | null;
  return { ok: res.ok, data };
}

// ── Config & status ──────────────────────────────────────────────────────────

/** GET /current-config — null when the response was not ok. */
export async function fetchCurrentConfig(): Promise<(RawSetupConfig & Record<string, unknown>) | null> {
  const res = await setupRequest('GET', '/current-config');
  if (!res.ok) return null;
  return (await res.json()) as RawSetupConfig & Record<string, unknown>;
}

export interface SetupStatusResponse { setupComplete?: boolean; }

/** GET /status — parses the body regardless of HTTP status (matches the mount check). */
export async function fetchSetupStatus(): Promise<SetupStatusResponse> {
  const res = await setupRequest('GET', '/status');
  return (await res.json()) as SetupStatusResponse;
}
