/**
 * GET /admin/connections/export/mem0 — Export current memory config as JSON.
 */
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  requireAdmin,
} from '$lib/server/helpers.js';
import {
  readStackSpec,
  parseCapabilityString,
  buildMem0Mapping,
} from '@openpalm/lib';
import { PROVIDER_KEY_MAP } from '$lib/provider-constants.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();

  const spec = readStackSpec(state.configDir);
  if (!spec) {
    return errorResponse(404, 'not_found', 'No stack configuration found. Complete wizard setup first.', {}, requestId);
  }

  const { capabilities } = spec;
  const { provider: llmProvider, model: llmModel } = parseCapabilityString(capabilities.llm);
  const embeddingProvider = capabilities.embeddings.provider;
  const apiKeyEnvRef = PROVIDER_KEY_MAP[llmProvider]
    ? `env:${PROVIDER_KEY_MAP[llmProvider]}`
    : 'not-needed';
  const embeddingApiKeyEnvRef = PROVIDER_KEY_MAP[embeddingProvider]
    ? `env:${PROVIDER_KEY_MAP[embeddingProvider]}`
    : 'not-needed';

  const mapping = buildMem0Mapping({
    llm: {
      provider: llmProvider,
      baseUrl: '',
      model: llmModel,
      apiKeyRef: apiKeyEnvRef,
    },
    embedder: {
      provider: embeddingProvider,
      baseUrl: '',
      model: capabilities.embeddings.model,
      apiKeyRef: embeddingApiKeyEnvRef,
    },
    embeddingDims: capabilities.embeddings.dims,
    customInstructions: capabilities.memory.customInstructions ?? '',
  });

  return new Response(JSON.stringify(mapping, null, 2) + '\n', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="mem0-config.json"',
      'x-request-id': requestId,
    },
  });
};
