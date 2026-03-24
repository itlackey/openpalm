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
  const apiKeyRef = PROVIDER_KEY_MAP[llmProvider]
    ? `env:${PROVIDER_KEY_MAP[llmProvider]}`
    : '';
  const embeddingApiKeyRef = PROVIDER_KEY_MAP[embeddingProvider]
    ? `env:${PROVIDER_KEY_MAP[embeddingProvider]}`
    : '';

  const config = {
    mem0: {
      llm: {
        provider: llmProvider,
        config: {
          model: llmModel,
          temperature: 0.1,
          max_tokens: 2000,
          api_key: apiKeyRef,
        },
      },
      embedder: {
        provider: embeddingProvider,
        config: {
          model: capabilities.embeddings.model,
          api_key: embeddingApiKeyRef,
        },
      },
      vector_store: {
        provider: 'sqlite-vec',
        config: {
          collection_name: 'memory',
          db_path: '/data/memory.db',
          embedding_model_dims: capabilities.embeddings.dims,
        },
      },
    },
    memory: {
      custom_instructions: capabilities.memory.customInstructions ?? '',
    },
  };

  return new Response(JSON.stringify(config, null, 2) + '\n', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="mem0-config.json"',
      'x-request-id': requestId,
    },
  });
};
