import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId } from '$lib/server/helpers.js';
import {
  getOpenCodeProviders,
  getOpenCodeProviderAuth,
} from '$lib/opencode/client.server.js';
import { sanitizeOpenCodeModels } from '$lib/opencode/provider-models.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const [providers, authMethods] = await Promise.all([
    getOpenCodeProviders(),
    getOpenCodeProviderAuth(),
  ]);

  const result = providers.map((p) => {
    const models = sanitizeOpenCodeModels(p.models, p.id);
    const env = Array.isArray(p.env) ? p.env : [];
    const methods = authMethods[p.id as string] ?? [];
    return {
      id: p.id,
      name: p.name ?? p.id,
      env,
      connected: Boolean(methods.length) || Boolean(p.key),
      modelCount: models.length,
      models,
      // OpenCode's /provider/auth only covers providers with auth plugins
      // (e.g. github-copilot, gitlab). Standard providers (openai, anthropic,
      // etc.) need API key auth but have no plugin — synthesize the default.
      authMethods: methods.length > 0 ? methods
        : env.length > 0 ? [{ type: 'api', label: 'API Key' }]
        : [],
    };
  });

  return jsonResponse(200, { providers: result }, requestId);
};
