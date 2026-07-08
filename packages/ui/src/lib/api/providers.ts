import { request, requireOk, requireJsonBody } from './core.js';
import type {
  ProviderPageState,
  AssistantCliToolStatus,
  ProviderActionResult,
} from '../types/providers.js';

// ── Providers (Connections tab) ───────────────────────────────────────────────
// Typed endpoint client for the providers/* UI. Every function routes through
// the shared transport core so 401s flow through `requireOk`/`requireJsonBody`
// and errors carry a `.status` the UI can branch on (see ./errors.ts).

/** Detected host OpenCode install summary (import-from-host banner). */
export type ProviderHostStatus = {
  detected: boolean;
  providerCount: number;
  credentialCount: number;
  configPath: string | null;
  authPath: string | null;
};

/** Result body of POST /api/host/providers/import-host. */
export type HostImportResult = {
  ok: boolean;
  imported: { providers: number; credentials: number };
  conflicts: string[];
  livePushed?: number;
  livePushFailed?: string[];
};

/** GET /api/host/providers — full connections page state. */
export async function fetchProviders(): Promise<ProviderPageState> {
  const res = await requireOk(await request('GET', '/api/host/providers'));
  return (await res.json()) as ProviderPageState;
}

/** GET /api/host/providers/assistant-clis — assistant CLI tool statuses. */
export async function fetchAssistantCliTools(): Promise<AssistantCliToolStatus[]> {
  const res = await requireOk(await request('GET', '/api/host/providers/assistant-clis'));
  const body = (await res.json()) as { tools?: AssistantCliToolStatus[] };
  return body.tools ?? [];
}

/** POST /api/assistant/model — set the default `model` or `small_model`. */
export async function saveOpencodeModel(
  target: 'model' | 'small_model',
  value: string
): Promise<void> {
  await requireOk(await request('POST', '/api/assistant/model', { [target]: value || null }));
}

/** DELETE /api/host/opencode/providers/{id}/auth — remove stored credentials. */
export async function disconnectProvider(providerId: string): Promise<void> {
  await requireOk(
    await request('DELETE', `/api/host/opencode/providers/${encodeURIComponent(providerId)}/auth`)
  );
}

/** GET /api/host/providers/host-status — detected host OpenCode summary. */
export async function fetchHostStatus(): Promise<ProviderHostStatus> {
  const res = await requireOk(await request('GET', '/api/host/providers/host-status'));
  return (await res.json()) as ProviderHostStatus;
}

/** POST /api/host/providers/assistant-clis/{toolId}/use-provider — seed a CLI's creds. */
export async function useAssistantCliProvider(
  toolId: AssistantCliToolStatus['id'],
  providerId: string
): Promise<void> {
  await requireOk(
    await request(
      'POST',
      `/api/host/providers/assistant-clis/${encodeURIComponent(toolId)}/use-provider`,
      { providerId }
    )
  );
}

/** POST /api/host/providers/oauth/start — begin an OAuth flow; body branches on result. */
export async function startProviderOauth(
  providerId: string,
  methodIndex: number
): Promise<ProviderActionResult> {
  return requireJsonBody<ProviderActionResult>(
    await request('POST', '/api/host/providers/oauth/start', {
      providerId,
      methodIndex: String(methodIndex),
    }),
    'OAuth start failed.'
  );
}

/**
 * POST /api/host/providers/oauth/{providerId}/callback — the long-poll that blocks
 * server-side until the OAuth flow completes. Returns the raw Response so the
 * caller can inspect status and abort via `signal`.
 */
export async function oauthCallback(
  providerId: string,
  methodIndex: number,
  signal: AbortSignal
): Promise<Response> {
  return request(
    'POST',
    `/api/host/providers/oauth/${encodeURIComponent(providerId)}/callback`,
    { method: methodIndex },
    { signal }
  );
}

/** POST /api/host/opencode/providers/{id}/auth — save an API key credential. */
export async function submitProviderApiKey(providerId: string, apiKey: string): Promise<void> {
  await requireOk(
    await request('POST', `/api/host/opencode/providers/${encodeURIComponent(providerId)}/auth`, {
      mode: 'api_key',
      apiKey,
    })
  );
}

/** POST /api/host/providers/oauth/finish — submit an OAuth authorization code. */
export async function finishProviderOauth(
  providerId: string,
  methodIndex: number,
  code: string
): Promise<void> {
  await requireOk(
    await request('POST', '/api/host/providers/oauth/finish', { providerId, methodIndex, code })
  );
}

/** PATCH /api/host/providers/{id} — register a custom OpenAI-compatible provider. */
export async function registerCustomProvider(
  id: string,
  input: { displayName: string; baseURL: string; apiKey?: string }
): Promise<ProviderActionResult> {
  const res = await request('PATCH', `/api/host/providers/${encodeURIComponent(id)}`, {
    kind: 'register-custom',
    displayName: input.displayName,
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    modelsJson: '[]',
    headersJson: '[]',
    confirmOverwrite: 'false',
  });
  const result = await requireJsonBody<ProviderActionResult>(res, 'Registration failed.');
  if (!res.ok || result.ok === false) {
    throw Object.assign(new Error(result.message ?? 'Registration failed.'), { status: res.status });
  }
  return result;
}

/** POST /api/host/providers/import-host — copy host OpenCode providers/credentials. */
export async function importHostProviders(): Promise<HostImportResult> {
  const res = await request('POST', '/api/host/providers/import-host');
  const body = await requireJsonBody<HostImportResult>(res, 'Import failed.');
  if (!res.ok) {
    throw Object.assign(
      new Error((body as unknown as { message?: string }).message ?? 'Import failed.'),
      { status: res.status }
    );
  }
  return body;
}
