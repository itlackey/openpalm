/**
 * /admin/providers/local
 *
 * GET  — probe Docker Model Runner / Ollama / LM Studio endpoints and
 *        return availability + baseURL for each.
 * POST — register a detected local provider as an OpenAI-compatible
 *        entry in the user's opencode.json. Body: `{ provider }`.
 *
 * Auth: admin token required on both verbs.
 */
import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  withAdminBody,
} from "$lib/server/helpers.js";
import {
  getCurrentConfig,
  patchConfig,
  actionSuccess,
  actionFailure,
} from "$lib/server/opencode/index.js";
import { detectLocalProviders } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const LOCAL_PROVIDER_LABELS: Record<string, string> = {
  ollama: "Local Ollama",
  lmstudio: "Local LM Studio",
  "model-runner": "Docker Model Runner",
};

const VALID_PROVIDER_IDS = new Set(Object.keys(LOCAL_PROVIDER_LABELS));

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const providers = await detectLocalProviders();
  return jsonResponse(200, { providers }, requestId);
};

export const POST: RequestHandler = (event) => withAdminBody(event, async ({ requestId, body }) => {
  const providerId = typeof body.provider === "string" ? body.provider.trim() : "";
  if (!providerId || !VALID_PROVIDER_IDS.has(providerId)) {
    return errorResponse(
      400,
      "bad_request",
      "provider must be one of: ollama, lmstudio, model-runner",
      {},
      requestId,
    );
  }

  // Re-probe just-in-time so we don't register a stale URL.
  const detected = await detectLocalProviders();
  const match = detected.find((d) => d.provider === providerId);
  if (!match || !match.available) {
    return jsonResponse(
      200,
      actionFailure(`No reachable ${LOCAL_PROVIDER_LABELS[providerId] ?? providerId} endpoint found.`, providerId),
      requestId,
    );
  }

  try {
    const config = await getCurrentConfig();
    const providerConfig = { ...(config.provider ?? {}) };
    const existing = providerConfig[providerId] as Record<string, unknown> | undefined;
    const existingOptions = (existing?.options as Record<string, unknown> | undefined) ?? {};

    providerConfig[providerId] = {
      // Keep any extra fields a previous registration added (npm, headers,
      // models) and just refresh the baseURL to whatever the probe found.
      // New entries default to the openai-compatible adapter.
      npm: typeof existing?.npm === "string" ? existing.npm : "@ai-sdk/openai-compatible",
      name: typeof existing?.name === "string" ? existing.name : LOCAL_PROVIDER_LABELS[providerId] ?? providerId,
      options: {
        ...existingOptions,
        baseURL: match.url,
      },
    };

    config.provider = providerConfig;
    await patchConfig(config);

    return jsonResponse(
      200,
      actionSuccess(`Registered ${LOCAL_PROVIDER_LABELS[providerId] ?? providerId} at ${match.url}.`, providerId),
      requestId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(200, actionFailure(message, providerId), requestId);
  }
});
