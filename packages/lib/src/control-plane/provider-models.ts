/**
 * Provider model discovery and API key resolution.
 *
 * Used by the admin capabilities test endpoint and the CLI setup wizard
 * to enumerate the models a configured provider exposes.
 */
import { readStackRuntimeEnv } from "./secrets.js";
import { PROVIDER_DEFAULT_URLS } from "../provider-constants.js";

/** Static model list for Anthropic (no listing API available). */
const ANTHROPIC_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
];


/**
 * Resolve an API key reference.
 *
 * - Empty input → empty string.
 * - `env:NAME` form → looks up `NAME` in `process.env` first, then falls back
 *   to the name-routed file-secret stores under `homeDir`.
 * - Anything else → returned verbatim (treated as a literal key value).
 */
function resolveApiKey(apiKeyRef: string, homeDir: string): string {
  if (!apiKeyRef) return "";
  if (!apiKeyRef.startsWith("env:")) return apiKeyRef;

  const varName = apiKeyRef.slice(4);
  const fromProcessEnv = process.env[varName];
  if (fromProcessEnv) return fromProcessEnv;

  const secrets = readStackRuntimeEnv(homeDir);
  return secrets[varName] ?? "";
}


export type ModelDiscoveryReason =
  | 'none'
  | 'provider_static'
  | 'provider_http'
  | 'missing_base_url'
  | 'timeout'
  | 'network';

export type ProviderModelsResult = {
  models: string[];
  status: 'ok' | 'recoverable_error';
  reason: ModelDiscoveryReason;
  error?: string;
};

const HTTP_STATUS_LABELS: Record<number, string> = {
  401: 'Invalid or missing API key',
  403: 'Access denied — check API key permissions',
  404: 'Endpoint not found — verify the base URL',
  429: 'Rate limited — try again shortly',
  500: 'Provider internal error',
  502: 'Provider returned a bad gateway error',
  503: 'Provider is temporarily unavailable',
};

/**
 * Enumerate available models for a provider. Returns an `ok` result with a
 * sorted model list when the provider responds successfully, or a
 * `recoverable_error` with a structured reason otherwise. Network and timeout
 * failures are caught and mapped to a result rather than thrown.
 */
export async function fetchProviderModels(
  provider: string,
  apiKeyRef: string,
  baseUrl: string,
  homeDir: string
): Promise<ProviderModelsResult> {
  try {
    if (provider === "anthropic") {
      return { models: [...ANTHROPIC_MODELS], status: 'ok', reason: 'provider_static' };
    }

    const resolvedKey = resolveApiKey(apiKeyRef, homeDir);

    if (provider === "ollama") {
      const base = baseUrl?.trim() || PROVIDER_DEFAULT_URLS.ollama;
      const url = `${base.replace(/\/+$/, "")}/api/tags`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        return {
          models: [],
          status: 'recoverable_error',
          reason: 'provider_http',
          error: `Ollama API returned ${res.status}: ${(HTTP_STATUS_LABELS[res.status] ?? `HTTP ${res.status}`)}`,
        };
      }
      const data = (await res.json()) as { models?: { name: string }[] };
      const models = (data.models ?? []).map((m) => m.name).sort();
      return { models, status: 'ok', reason: 'none' };
    }

    const base = baseUrl?.trim() || PROVIDER_DEFAULT_URLS[provider] || "";
    if (!base) {
      return {
        models: [],
        status: 'recoverable_error',
        reason: 'missing_base_url',
        error: `No base URL configured for provider "${provider}"`,
      };
    }
    const url = `${base.replace(/\/+$/, "")}/v1/models`;

    const headers: Record<string, string> = {};
    if (resolvedKey) {
      headers.Authorization = `Bearer ${resolvedKey}`;
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      let detail = '';
      try {
        const json = JSON.parse(await res.text()) as Record<string, unknown>;
        const errObj = json.error as Record<string, unknown> | string | undefined;
        detail = (typeof errObj === 'object' && errObj !== null && typeof errObj.message === 'string') ? errObj.message
          : typeof errObj === 'string' ? errObj
          : typeof json.message === 'string' ? json.message
          : typeof json.detail === 'string' ? json.detail : '';
      } catch { /* ignore parse errors */ }
      return {
        models: [],
        status: 'recoverable_error',
        reason: 'provider_http',
        error: detail
          ? `Provider API returned ${res.status}: ${detail}`
          : `Provider API returned ${res.status}: ${(HTTP_STATUS_LABELS[res.status] ?? `HTTP ${res.status}`)}`,
      };
    }
    const data = (await res.json()) as { data?: { id: string }[] };
    const models = (data.data ?? []).map((m) => m.id).sort();
    return { models, status: 'ok', reason: 'none' };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? "Request timed out after 5s"
        : String(err);
    return {
      models: [],
      status: 'recoverable_error',
      reason: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network',
      error: message,
    };
  }
}
