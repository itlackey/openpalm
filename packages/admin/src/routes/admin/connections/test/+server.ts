import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  jsonResponse,
  errorResponse,
  getRequestId,
  parseJsonBody,
  requireAdminOrSetupToken,
  validateExternalUrl,
} from '$lib/server/helpers.js';
import { fetchProviderModels } from '$lib/server/memory-config.js';
import { createLogger } from '$lib/server/logger.js';
import { mapDiscoveryResultToErrorCode } from '$lib/model-discovery.js';

const logger = createLogger('connections-test');

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdminOrSetupToken(event, requestId);
  if (authError) return authError;

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, 'invalid_input', 'Request body must be valid JSON', {}, requestId);
  }

  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  const apiKey  = typeof body.apiKey  === 'string' ? body.apiKey  : '';
  const kind    = typeof body.kind    === 'string' ? body.kind    : 'unknown';

  if (!baseUrl) {
    return errorResponse(400, 'invalid_input', 'baseUrl is required', {}, requestId);
  }

  const ssrfError = validateExternalUrl(baseUrl);
  if (ssrfError) {
    return errorResponse(400, 'blocked_url', ssrfError, {}, requestId);
  }

  const state = getState();

  // Derive minimal provider hint for fetchProviderModels
  const derivedProvider = deriveProvider(baseUrl);
  logger.info('connection test', { requestId, derivedProvider, kind });

  const result = await fetchProviderModels(derivedProvider, apiKey, baseUrl, state.configDir);
  const ok = result.status === 'ok';
  const errorCode = ok ? undefined : mapDiscoveryResultToErrorCode(result);

  return jsonResponse(200, {
    ok,
    models: ok ? result.models : undefined,
    error:  ok ? undefined : result.error,
    errorCode,
  }, requestId);
};

function deriveProvider(baseUrl: string): string {
  const lower = baseUrl.toLowerCase();
  if (lower.includes('ollama') || lower.includes(':11434')) return 'ollama';
  return 'openai';
}
