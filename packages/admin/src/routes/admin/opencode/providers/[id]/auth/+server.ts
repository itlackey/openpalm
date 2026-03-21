import type { RequestHandler } from './$types';
import {
  requireAdmin,
  jsonResponse,
  errorResponse,
  getRequestId,
  getActor,
  getCallerType,
  parseJsonBody,
} from '$lib/server/helpers.js';
import {
  setProviderApiKey,
  startProviderOAuth,
  completeProviderOAuth,
} from '$lib/opencode/client.server.js';
import { getState } from '$lib/server/state.js';
import { appendAudit, patchSecretsEnvFile } from '$lib/server/control-plane.js';
import { PROVIDER_KEY_MAP } from '$lib/provider-constants.js';
import { createLogger } from '$lib/server/logger.js';

const logger = createLogger('opencode.auth');

// ── API key validation ────────────────────────────────────────────────
const MAX_API_KEY_LENGTH = 512;
const API_KEY_PATTERN = /^[\x20-\x7E]+$/; // printable ASCII only

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

// Lazy cleanup: purge expired sessions on access rather than setInterval
function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of oauthSessions) {
    if (now - session.createdAt > 600_000) {
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
  const result = await completeProviderOAuth(session.providerId, session.methodIndex);

  if (result.ok) {
    oauthSessions.delete(pollToken);
    logger.info('oauth authorization completed', { providerId: session.providerId, requestId });
    return jsonResponse(200, { status: 'complete', message: 'Authorization successful' }, requestId);
  }

  // Check if expired
  if (Date.now() - session.createdAt > 600_000) {
    oauthSessions.delete(pollToken);
    return jsonResponse(200, { status: 'error', message: 'Authorization session expired' }, requestId);
  }

  return jsonResponse(200, { status: 'pending', message: 'Waiting for authorization...' }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, 'invalid_input', 'Request body must be valid JSON', {}, requestId);
  }

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const providerId = event.params.id;
  const mode = typeof body.mode === 'string' ? body.mode : '';

  if (mode === 'api_key') {
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!apiKey) {
      return errorResponse(400, 'bad_request', 'apiKey is required for api_key mode', {}, requestId);
    }

    // H1 fix: validate API key format before writing to vault
    const keyError = validateApiKey(apiKey);
    if (keyError) {
      return errorResponse(400, 'bad_request', keyError, {}, requestId);
    }

    // Write to vault/user/user.env
    const envVarName =
      PROVIDER_KEY_MAP[providerId] ??
      `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    try {
      patchSecretsEnvFile(state.vaultDir, { [envVarName]: apiKey });
    } catch {
      appendAudit(state, actor, 'opencode.auth.api_key', { providerId, error: 'vault_write_failed' }, false, requestId, callerType);
      return errorResponse(500, 'internal_error', 'Failed to write API key to vault', {}, requestId);
    }

    // Also register with OpenCode (non-critical)
    await setProviderApiKey(providerId, apiKey).catch(() => {});

    // L1 fix: audit log for security-sensitive operations
    appendAudit(state, actor, 'opencode.auth.api_key', { providerId }, true, requestId, callerType);
    logger.info('provider API key saved', { providerId, requestId });

    return jsonResponse(200, { ok: true, mode: 'api_key' }, requestId);
  }

  if (mode === 'oauth') {
    const methodIndex = typeof body.methodIndex === 'number' ? body.methodIndex : 0;

    const result = await startProviderOAuth(providerId, methodIndex);
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

    // L1 fix: audit log for OAuth initiation
    appendAudit(state, actor, 'opencode.auth.oauth.start', { providerId, methodIndex }, true, requestId, callerType);
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
