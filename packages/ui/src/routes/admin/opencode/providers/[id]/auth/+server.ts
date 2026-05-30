import type { RequestHandler } from './$types';
import {
  requireAdmin,
  jsonResponse,
  errorResponse,
  getRequestId,
  parseJsonBody,
  jsonBodyError,
  getOpenCodeClient,
} from '$lib/server/helpers.js';
import { createLogger } from '@openpalm/lib';

const logger = createLogger('opencode.auth');

// ── API key validation ────────────────────────────────────────────────
const MAX_API_KEY_LENGTH = 512;
const API_KEY_PATTERN = /^[\x20-\x7E]+$/; // printable ASCII only
const OAUTH_SESSION_TTL_MS = 600_000;
const MAX_PROVIDER_ID_LENGTH = 128;
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

function validateApiKey(key: string): string | null {
  if (key.length > MAX_API_KEY_LENGTH) return 'API key exceeds maximum length';
  if (!API_KEY_PATTERN.test(key)) return 'API key contains invalid characters';
  return null;
}

// ── Server-side OAuth poll session storage (in-memory, short-lived) ───
const oauthSessions = new Map<string, {
  providerId: string;
  methodIndex: number;
  createdAt: number;
}>();

function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of oauthSessions) {
    if (now - session.createdAt > OAUTH_SESSION_TTL_MS) {
      oauthSessions.delete(token);
    }
  }
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const pollToken = event.url.searchParams.get('pollToken');
  if (!pollToken) {
    return errorResponse(400, 'bad_request', 'pollToken query parameter is required', {}, requestId);
  }

  purgeExpiredSessions();

  const session = oauthSessions.get(pollToken);
  if (!session) {
    return errorResponse(404, 'not_found', 'Poll session not found or expired', {}, requestId);
  }

  // Verify the URL provider matches the session provider (M2 fix)
  const providerId = event.params.id;
  if (providerId !== session.providerId) {
    return errorResponse(400, 'bad_request', 'Provider ID does not match poll session', {}, requestId);
  }

  // Try to complete the OAuth flow (user may have authorized in their browser)
  const result = await getOpenCodeClient().completeProviderOAuth(session.providerId, session.methodIndex);

  if (result.ok) {
    oauthSessions.delete(pollToken);
    logger.info('oauth authorization completed', { providerId: session.providerId, requestId });
    return jsonResponse(200, { status: 'complete', message: 'Authorization successful' }, requestId);
  }

  // Check if expired
  if (Date.now() - session.createdAt > OAUTH_SESSION_TTL_MS) {
    oauthSessions.delete(pollToken);
    return jsonResponse(200, { status: 'error', message: 'Authorization session expired' }, requestId);
  }

  return jsonResponse(200, { status: 'pending', message: 'Waiting for authorization...' }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data;

  const providerId = event.params.id;
  const mode = typeof body.mode === 'string' ? body.mode : '';

  // Validate providerId from URL parameter
  if (!providerId || providerId.length > MAX_PROVIDER_ID_LENGTH || !PROVIDER_ID_PATTERN.test(providerId)) {
    return errorResponse(400, 'bad_request', 'Invalid provider ID', {}, requestId);
  }

  purgeExpiredSessions();

  if (mode === 'api_key') {
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!apiKey) {
      return errorResponse(400, 'bad_request', 'apiKey is required for api_key mode', {}, requestId);
    }

    const keyError = validateApiKey(apiKey);
    if (keyError) {
      return errorResponse(400, 'bad_request', keyError, {}, requestId);
    }

    // Connections is a thin wrapper around OpenCode's auth API. The
    // single source of truth for provider credentials is OpenCode's
    // own auth.json, which is bind-mounted into the assistant
    // container. We do not duplicate provider keys into stack secrets
    // or the AKM user vault.
    const result = await getOpenCodeClient().setProviderApiKey(providerId, apiKey);
    if (!result.ok) {
      logger.warn('provider api key save failed', { providerId, requestId, error: result.code });
      return errorResponse(result.status, result.code, result.message, {}, requestId);
    }

    logger.info('provider API key saved to OpenCode auth.json', { providerId, requestId });

    return jsonResponse(200, { ok: true, mode: 'api_key' }, requestId);
  }

  if (mode === 'oauth') {
    if (typeof body.methodIndex !== 'undefined' && (typeof body.methodIndex !== 'number' || !Number.isInteger(body.methodIndex) || body.methodIndex < 0)) {
      return errorResponse(400, 'bad_request', 'methodIndex must be a non-negative integer', {}, requestId);
    }
    const methodIndex = typeof body.methodIndex === 'number' ? body.methodIndex : 0;

    const result = await getOpenCodeClient().startProviderOAuth(providerId, methodIndex);
    if (!result.ok) {
      return errorResponse(result.status, result.code, result.message, {}, requestId);
    }

    const data = result.data as { url: string; method: string; instructions: string };
    const pollToken = crypto.randomUUID();

    oauthSessions.set(pollToken, {
      providerId,
      methodIndex,
      createdAt: Date.now(),
    });

    logger.info('oauth authorization started', { providerId, methodIndex, requestId });

    return jsonResponse(200, {
      ok: true,
      mode: 'oauth',
      pollToken,
      url: data.url,
      method: data.method,
      instructions: data.instructions,
    }, requestId);
  }

  // L2 fix: static error message, don't echo caller input
  return errorResponse(400, 'bad_request', 'mode must be api_key or oauth', {}, requestId);
};

/**
 * DELETE /admin/opencode/providers/:id/auth — Disconnect a provider by
 * removing its credential from OpenCode's auth.json.
 */
export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const providerId = event.params.id ?? '';
  if (!providerId || providerId.length > MAX_PROVIDER_ID_LENGTH || !PROVIDER_ID_PATTERN.test(providerId)) {
    return errorResponse(400, 'bad_request', 'Invalid provider ID', {}, requestId);
  }

  const result = await getOpenCodeClient().proxy(
    `/auth/${encodeURIComponent(providerId)}`,
    { method: 'DELETE' },
  );

  if (!result.ok) {
    logger.warn('provider disconnect failed', { providerId, requestId, error: result.code });
    return errorResponse(result.status, result.code, result.message, {}, requestId);
  }

  logger.info('provider credential removed via OpenCode /auth DELETE', { providerId, requestId });

  return jsonResponse(200, { ok: true }, requestId);
};
