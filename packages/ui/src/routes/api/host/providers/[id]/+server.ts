/**
 * PATCH /api/host/providers/:id — Single endpoint for all provider mutations.
 *
 * Discriminated by `body.kind`:
 *   "options"   — save connection settings (baseURL, headers, timeout, …)
 *   "toggle"    — enable or disable the provider for model selection
 *   "register"  — register a local-detected or custom OpenAI-compatible provider
 *
 * Auth: admin token required.
 * OAuth credential saves go to /api/host/opencode/providers/:id/auth (unchanged).
 */
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
  setProviderOptions,
  setProviderEnabled,
  setMainModel,
  patchConfig,
  getCurrentConfig,
  registerProvider,
} from '$lib/server/opencode/config.js';
import type { ProviderActionResult } from '$lib/types/providers.js';
import { detectLocalProviders } from '@openpalm/lib';
import { createLogger } from '@openpalm/lib';
import {
  asStringOrEmpty,
  updateNumberOption,
  updateBooleanOption,
  parseHeaders,
  parseModels,
  buildModelConfig,
} from '../_helpers.js';

const logger = createLogger('admin.providers.patch');

/** Allowed format for a custom provider id */
const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9_-]+$/;

const LOCAL_PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Local Ollama',
  lmstudio: 'Local LM Studio',
  'model-runner': 'Docker Model Runner',
};

export const PATCH: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const providerId = event.params.id;
  const parsed = await parseJsonBody(event.request);
  if ('error' in parsed) return jsonBodyError(parsed, requestId);
  const body = parsed.data;

  const kind = typeof body.kind === 'string' ? body.kind : '';

  if (kind === 'options') {
    // Save non-credential connection settings
    try {
      const baseURL = asStringOrEmpty(body.baseURL);
      const enterpriseUrl = asStringOrEmpty(body.enterpriseUrl);
      const headers = parseHeaders(asStringOrEmpty(body.headers));

      const nextOptions: Record<string, unknown> = {};
      updateNumberOption(nextOptions, 'timeout', asStringOrEmpty(body.timeout));
      updateBooleanOption(nextOptions, 'setCacheKey', body.setCacheKey === 'on' || body.setCacheKey === true);

      await setProviderOptions(providerId, {
        baseURL: baseURL || undefined,
        enterpriseUrl: enterpriseUrl || undefined,
        timeout: typeof nextOptions.timeout === 'number' ? nextOptions.timeout : undefined,
        setCacheKey: nextOptions.setCacheKey === true,
        headers: headers && Object.keys(headers).length > 0 ? headers : null,
      });

      return jsonResponse(200, { ok: true, message: 'Provider settings saved.', selectedProviderId: providerId } satisfies ProviderActionResult, requestId);
    } catch (error) {
      return jsonResponse(200, { ok: false, message: error instanceof Error ? error.message : 'Internal error', selectedProviderId: undefined } satisfies ProviderActionResult, requestId);
    }
  }

  if (kind === 'toggle') {
    // Enable or disable for model selection
    try {
      const nextState = asStringOrEmpty(body.enabled) === 'true' || body.enabled === true;
      const config = await getCurrentConfig();
      await patchConfig(setProviderEnabled(config, providerId, nextState));
      return jsonResponse(200, { ok: true, message: nextState ? 'Provider enabled for model selection.' : 'Provider disabled for this workspace.', selectedProviderId: providerId } satisfies ProviderActionResult, requestId);
    } catch (error) {
      return jsonResponse(200, { ok: false, message: error instanceof Error ? error.message : 'Internal error', selectedProviderId: undefined } satisfies ProviderActionResult, requestId);
    }
  }

  if (kind === 'register-local') {
    // Register a detected local provider
    try {
      if (!Object.hasOwn(LOCAL_PROVIDER_LABELS, providerId)) {
        return errorResponse(400, 'bad_request', 'provider must be one of: ollama, lmstudio, model-runner', {}, requestId);
      }
      const detected = await detectLocalProviders();
      const match = detected.find((d) => d.provider === providerId);
      if (!match?.available) {
        return jsonResponse(200, { ok: false, message: `No reachable ${LOCAL_PROVIDER_LABELS[providerId] ?? providerId} endpoint found.`, selectedProviderId: providerId } satisfies ProviderActionResult, requestId);
      }

      const config = await getCurrentConfig();
      const existingEntry = config.provider?.[providerId] as Record<string, unknown> | undefined;
      const existingOptions = (existingEntry?.options as Record<string, unknown> | undefined) ?? {};
      await registerProvider(providerId, {
        npm: typeof existingEntry?.npm === 'string' ? existingEntry.npm : '@ai-sdk/openai-compatible',
        name: typeof existingEntry?.name === 'string' ? existingEntry.name : LOCAL_PROVIDER_LABELS[providerId] ?? providerId,
        options: { ...existingOptions, baseURL: match.url },
      }, true);

      return jsonResponse(200, { ok: true, message: `Registered ${LOCAL_PROVIDER_LABELS[providerId] ?? providerId} at ${match.url}.`, selectedProviderId: providerId } satisfies ProviderActionResult, requestId);
    } catch (err) {
      return jsonResponse(200, { ok: false, message: err instanceof Error ? err.message : String(err), selectedProviderId: providerId } satisfies ProviderActionResult, requestId);
    }
  }

  if (kind === 'register-custom') {
    // Register a user-defined custom OpenAI-compatible provider
    try {
      const displayName = asStringOrEmpty(body.displayName);
      const baseURL = asStringOrEmpty(body.baseURL);
      const apiKey = asStringOrEmpty(body.apiKey);
      const confirmOverwrite = asStringOrEmpty(body.confirmOverwrite) === 'true';

      if (!CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) {
        return jsonResponse(200, { ok: false, message: 'Use a lowercase provider id with letters, numbers, hyphens, or underscores.', selectedProviderId: undefined } satisfies ProviderActionResult, requestId);
      }
      if (!displayName || !baseURL) {
        return jsonResponse(200, { ok: false, message: 'Display name and base URL are required for a custom provider.', selectedProviderId: providerId } satisfies ProviderActionResult, requestId);
      }

      const models = parseModels(asStringOrEmpty(body.modelsJson));
      const headers = parseHeaders(asStringOrEmpty(body.headersJson));
      const entry: Record<string, unknown> = {
        npm: '@ai-sdk/openai-compatible',
        name: displayName,
        options: {
          baseURL,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
      };
      if (models.length > 0) {
        entry.models = Object.fromEntries(models.map((m) => [m.id, buildModelConfig(m)]));
      }

      const result = await registerProvider(providerId, entry, confirmOverwrite);
      if (result.alreadyExists) {
        return jsonResponse(200, { ok: false, message: 'A provider with this ID already exists. Enable overwrite to replace it.', selectedProviderId: providerId } satisfies ProviderActionResult, requestId);
      }

      if (apiKey) {
        try {
          const authResult = await getOpenCodeClient().setProviderApiKey(providerId, apiKey);
          if (!authResult.ok) {
            logger.warn('custom provider apiKey save failed', { providerId, code: authResult.code, message: authResult.message, requestId });
          }
        } catch (err) {
          logger.warn('custom provider apiKey threw', { providerId, error: String(err), requestId });
        }
      }

      return jsonResponse(200, { ok: true, message: 'Custom provider saved.', selectedProviderId: providerId } satisfies ProviderActionResult, requestId);
    } catch (error) {
      return jsonResponse(200, { ok: false, message: error instanceof Error ? error.message : 'Internal error', selectedProviderId: undefined } satisfies ProviderActionResult, requestId);
    }
  }

  if (kind === 'set-model') {
    // Set the active model for this provider in opencode.json
    try {
      const modelId = asStringOrEmpty(body.modelId);
      const target = asStringOrEmpty(body.target);
      if (!modelId || (target !== 'model' && target !== 'small_model')) {
        return jsonResponse(200, { ok: false, message: 'Choose a provider model before saving it.', selectedProviderId: undefined } satisfies ProviderActionResult, requestId);
      }
      await setMainModel(providerId, modelId, target);
      return jsonResponse(200, { ok: true, message: target === 'model' ? 'Main model updated for this project.' : 'Small model updated for lightweight tasks.', selectedProviderId: providerId } satisfies ProviderActionResult, requestId);
    } catch (error) {
      return jsonResponse(200, { ok: false, message: error instanceof Error ? error.message : 'Internal error', selectedProviderId: undefined } satisfies ProviderActionResult, requestId);
    }
  }

  return errorResponse(400, 'bad_request', `Unknown kind "${kind}". Expected: options, toggle, register-local, register-custom, set-model`, {}, requestId);
};
