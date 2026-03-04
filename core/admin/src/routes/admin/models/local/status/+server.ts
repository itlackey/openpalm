/**
 * GET /admin/models/local/status
 *
 * Check download/readiness status of configured local models.
 */
import {
  getRequestId,
  jsonResponse,
  requireAdmin
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  detectModelRunner,
  readLocalModelsCompose,
  listPulledModels
} from "$lib/server/control-plane.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const config = readLocalModelsCompose(state.configDir);

  if (!config || (!config.systemModel && !config.embeddingModel)) {
    return jsonResponse(200, {
      systemModelReady: false,
      embeddingModelReady: false,
      configured: false,
    }, requestId);
  }

  const detection = await detectModelRunner();
  if (!detection.available) {
    return jsonResponse(200, {
      systemModelReady: false,
      embeddingModelReady: false,
      configured: true,
      modelRunnerAvailable: false,
    }, requestId);
  }

  const pulledModels = await listPulledModels(detection.url);

  const systemModelReady = config.systemModel
    ? pulledModels.some((m) => m === config.systemModel!.model || m.startsWith(config.systemModel!.model))
    : false;

  const embeddingModelReady = config.embeddingModel
    ? pulledModels.some((m) => m === config.embeddingModel!.model || m.startsWith(config.embeddingModel!.model))
    : false;

  return jsonResponse(200, {
    systemModelReady,
    embeddingModelReady,
    configured: true,
    modelRunnerAvailable: true,
    systemModel: config.systemModel?.model ?? null,
    embeddingModel: config.embeddingModel?.model ?? null,
  }, requestId);
};
