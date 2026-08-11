import type { RequestHandler } from './$types';
import {
  requireAdmin,
  requireCapability,
  jsonResponse,
  errorResponse,
  getRequestId,
  parseJsonBody,
  jsonBodyError,
  getOpenCodeClient,
} from '$lib/server/helpers.js';
import {
  buildComposeOptions,
  composeRestart,
  createLogger,
  guardianRequired,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';

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
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
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

/**
 * Propagate a credential change to the guardian.
 *
 * Only the guardian. This route mutates credentials THROUGH the assistant's
 * own OpenCode API, so the assistant's running auth store is already current
 * and restarting it would drop live chats for nothing. The guardian is
 * different: it receives `auth.json` as a Compose secret and copies it into
 * place at boot (containers/guardian/entrypoint.sh), so until it restarts it
 * keeps serving every portal with the credentials it started with.
 *
 * That is the security half. Disconnecting a provider left the revoked
 * credential live behind chat/api/discord/slack indefinitely — the UI said
 * disconnected and the portals kept working.
 *
 * Best-effort by design: the credential change itself already succeeded and
 * must be reported as such. A failed restart is logged and surfaced as a
 * warning on the response, never as a failure of the save.
 */
async function propagateToGuardian(requestId: string): Promise<string | undefined> {
  const state = getState();
  if (!guardianRequired(state.homeDir)) return undefined;
  try {
    const result = await composeRestart(['guardian'], buildComposeOptions(state));
    if (result.ok) return undefined;
    logger.warn('guardian restart after credential change failed', { requestId, stderr: result.stderr });
    return 'The credential was saved, but the guardian could not be restarted, so portals may still use the previous credentials until it restarts.';
  } catch (err) {
    logger.warn('guardian restart after credential change threw', { requestId, error: String(err) });
    return 'The credential was saved, but the guardian could not be restarted, so portals may still use the previous credentials until it restarts.';
  }
}

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
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

    const warning = await propagateToGuardian(requestId);
    return jsonResponse(200, { ok: true, mode: 'api_key', ...(warning ? { warning } : {}) }, requestId);
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
 * DELETE /api/host/opencode/providers/:id/auth — Disconnect a provider by
 * removing its credential from OpenCode's auth.json.
 */
export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
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

  const warning = await propagateToGuardian(requestId);
  return jsonResponse(200, { ok: true, ...(warning ? { warning } : {}) }, requestId);
};
