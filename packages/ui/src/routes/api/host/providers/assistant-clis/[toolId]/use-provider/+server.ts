import type { RequestHandler } from './$types';
import { createLogger, useExistingProviderForAssistantCli, type AssistantCliToolId } from '@openpalm/lib';
import {
  errorResponse,
  getRequestId,
  jsonBodyError,
  jsonResponse,
  parseJsonBody,
  requireAdmin,
  requireCapability,
} from '$lib/server/helpers.js';
import { getState } from '$lib/server/state.js';

const logger = createLogger('admin.assistant-cli-tools');

function isAssistantCliToolId(value: string): value is AssistantCliToolId {
  return value === 'codex' || value === 'claude' || value === 'copilot' || value === 'pi';
}

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const toolId = event.params.toolId ?? '';
  if (!isAssistantCliToolId(toolId)) {
    return errorResponse(400, 'bad_request', 'Invalid assistant CLI tool id', {}, requestId);
  }

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);

  const providerId = typeof result.data.providerId === 'string' ? result.data.providerId.trim() : '';
  if (!providerId) {
    return errorResponse(400, 'bad_request', 'providerId is required', {}, requestId);
  }

  try {
    const writtenPaths = useExistingProviderForAssistantCli(getState(), toolId, providerId);
    logger.info('assistant CLI provider mapping written', { requestId, toolId, providerId, writtenPaths });
    return jsonResponse(200, { ok: true, toolId, providerId, writtenPaths }, requestId);
  } catch (error) {
    return errorResponse(
      400,
      'bad_request',
      error instanceof Error ? error.message : 'Failed to write assistant CLI credentials',
      {},
      requestId,
    );
  }
};
