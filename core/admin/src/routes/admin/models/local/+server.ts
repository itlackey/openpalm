/**
 * GET/POST/DELETE /admin/models/local
 *
 * Manage local AI models via Docker Model Runner.
 */
import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  getCallerType,
  parseJsonBody
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  detectModelRunner,
  readLocalModelsCompose,
  writeLocalModelsCompose,
  listPulledModels,
  isValidModelName,
  parseHfRef,
  fetchHuggingFaceModelInfo,
  downloadHuggingFaceModel,
  readLocalModelsMeta,
  writeLocalModelsMeta,
  updateModelMetadata,
  applyLocalModelsToOpenMemory,
  buildModelRestartServices,
  SUGGESTED_SYSTEM_MODELS,
  SUGGESTED_EMBEDDING_MODELS,
  LOCAL_EMBEDDING_DIMS,
  persistArtifacts,
  stageArtifacts,
  appendAudit,
  buildComposeFileList,
  buildEnvFiles,
  buildManagedServices,
  writeOpenMemoryConfig,
  readOpenMemoryConfig,
  resolveConfigForPush,
  pushConfigToOpenMemory,
  patchSecretsEnvFile,
  type LocalModelSelection
} from "$lib/server/control-plane.js";
import { composeUp } from "$lib/server/docker.js";
import { createLogger } from "$lib/server/logger.js";
import type { RequestHandler } from "./$types";

const logger = createLogger("models-local");

/**
 * GET /admin/models/local
 *
 * Returns Model Runner availability, current config, suggested models,
 * list of already-pulled models, and model metadata.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const [detection, config] = await Promise.all([
    detectModelRunner(),
    Promise.resolve(readLocalModelsCompose(state.dataDir, state.configDir)),
  ]);

  const pulledModels = detection.available
    ? await listPulledModels(detection.url)
    : [];

  const metadata = readLocalModelsMeta(state.dataDir);

  return jsonResponse(200, {
    modelRunnerAvailable: detection.available,
    modelRunnerUrl: detection.url,
    config,
    suggestedSystemModels: SUGGESTED_SYSTEM_MODELS,
    suggestedEmbeddingModels: SUGGESTED_EMBEDDING_MODELS,
    embeddingDims: LOCAL_EMBEDDING_DIMS,
    pulledModels,
    metadata,
  }, requestId);
};

/**
 * POST /admin/models/local
 *
 * Save local model configuration. Writes DATA_HOME/local-models.yml,
 * re-stages artifacts, and runs compose up.
 *
 * For HF models, verifies existence via HF Hub API and triggers background
 * download to DATA_HOME/models/hf-cache/ for persistence.
 *
 * Body: {
 *   systemModel?: { model: string, contextSize?: number },
 *   embeddingModel?: { model: string, dimensions?: number },
 *   applyToGuardian?: boolean,
 *   applyToMemory?: boolean
 * }
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const callerType = getCallerType(event);
  const state = getState();
  const body = await parseJsonBody(event.request);

  // Parse selection from body
  const selection: LocalModelSelection = {};

  if (body.systemModel && typeof body.systemModel === "object") {
    const sm = body.systemModel as Record<string, unknown>;
    const model = String(sm.model ?? "");
    if (model && !isValidModelName(model)) {
      return errorResponse(400, "invalid_model", `Invalid system model name: "${model}". Must start with ai/ or hf.co/`, {}, requestId);
    }
    if (model) {
      const contextSize = typeof sm.contextSize === "number" ? sm.contextSize : undefined;
      if (contextSize !== undefined && (!Number.isInteger(contextSize) || contextSize < 1)) {
        return errorResponse(400, "invalid_context_size", "Context size must be a positive integer", {}, requestId);
      }
      selection.systemModel = { model, contextSize };
    }
  }

  if (body.embeddingModel && typeof body.embeddingModel === "object") {
    const em = body.embeddingModel as Record<string, unknown>;
    const model = String(em.model ?? "");
    if (model && !isValidModelName(model)) {
      return errorResponse(400, "invalid_model", `Invalid embedding model name: "${model}". Must start with ai/ or hf.co/`, {}, requestId);
    }
    if (model) {
      const dims = typeof em.dimensions === "number" ? em.dimensions : (LOCAL_EMBEDDING_DIMS[model] ?? 384);
      if (!Number.isInteger(dims) || dims < 1) {
        return errorResponse(400, "invalid_dims", "Embedding dimensions must be a positive integer", {}, requestId);
      }
      selection.embeddingModel = { model, dimensions: dims };
    }
  }

  // For HF models, verify existence before saving
  const hfModels: string[] = [];
  if (selection.systemModel && parseHfRef(selection.systemModel.model)) {
    hfModels.push(selection.systemModel.model);
  }
  if (selection.embeddingModel && parseHfRef(selection.embeddingModel.model)) {
    hfModels.push(selection.embeddingModel.model);
  }

  for (const hfModel of hfModels) {
    const info = await fetchHuggingFaceModelInfo(hfModel);
    if (!info.exists) {
      return errorResponse(400, "model_not_found", `HuggingFace model not found: "${hfModel}"`, {}, requestId);
    }
    if (info.gated) {
      return errorResponse(400, "model_gated", `Model "${hfModel}" is gated and requires authentication`, {}, requestId);
    }
    // Store metadata
    updateModelMetadata(state.dataDir, hfModel, {
      source: "huggingface",
      pipelineTag: info.pipelineTag,
      downloads: info.downloads,
      contextSize: info.contextLength,
      status: "pending",
    });
  }

  // Detect Model Runner URL for compose overlay and config updates
  const detection = await detectModelRunner();
  const modelRunnerUrl = detection.url;

  // Write compose overlay
  writeLocalModelsCompose(state.dataDir, selection, modelRunnerUrl);

  // Apply to system connection config if requested
  const applyToGuardian = body.applyToGuardian === true;
  if (applyToGuardian && modelRunnerUrl) {
    // modelRunnerUrl is base URL without /v1 (e.g. http://host:port/engines)
    const localSecrets: Record<string, string> = {
      SYSTEM_LLM_PROVIDER: "openai",
      SYSTEM_LLM_BASE_URL: modelRunnerUrl,
      // OPENAI_BASE_URL is read by the openmemory container as env var fallback
      OPENAI_BASE_URL: `${modelRunnerUrl.replace(/\/+$/, "")}/v1`,
    };
    if (selection.systemModel) {
      localSecrets.SYSTEM_LLM_MODEL = selection.systemModel.model;
    }
    if (selection.embeddingModel) {
      localSecrets.EMBEDDING_MODEL = selection.embeddingModel.model;
      localSecrets.EMBEDDING_DIMS = String(selection.embeddingModel.dimensions ?? 384);
    }
    patchSecretsEnvFile(state.configDir, localSecrets);
  }

  // Apply to OpenMemory config if requested
  const applyToMemory = body.applyToMemory === true;
  if (applyToMemory && modelRunnerUrl) {
    const omConfig = readOpenMemoryConfig(state.dataDir);
    applyLocalModelsToOpenMemory(omConfig, selection, modelRunnerUrl);
    writeOpenMemoryConfig(state.dataDir, omConfig);

    // Push to running OpenMemory container (fire-and-forget)
    void (async () => {
      const resolved = resolveConfigForPush(omConfig, state.configDir);
      await pushConfigToOpenMemory(resolved);
    })();
  }

  // Stage all artifacts once after all config changes
  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);

  // Targeted restart: only restart affected services
  const restartServices = buildModelRestartServices(applyToGuardian, applyToMemory);

  const composeResult = await composeUp(state.stateDir, {
    files: buildComposeFileList(state),
    envFiles: buildEnvFiles(state),
    services: restartServices.length > 0
      ? restartServices
      : buildManagedServices(state),
  });

  // Fire-and-forget: download HF models in background for cache persistence
  for (const hfModel of hfModels) {
    void (async () => {
      updateModelMetadata(state.dataDir, hfModel, { status: "downloading" });
      const result = await downloadHuggingFaceModel(hfModel, state.dataDir);
      if (result.error) {
        updateModelMetadata(state.dataDir, hfModel, { status: "error", error: result.error });
        logger.warn("HF model download failed", { model: hfModel, error: result.error });
      } else {
        updateModelMetadata(state.dataDir, hfModel, {
          status: "ready",
          downloadedAt: new Date().toISOString(),
          error: undefined,
        });
        logger.info("HF model downloaded", { model: hfModel, path: result.localPath });
      }
    })();
  }

  appendAudit(
    state,
    "models.local",
    "models.local.save",
    {
      systemModel: selection.systemModel?.model ?? null,
      embeddingModel: selection.embeddingModel?.model ?? null,
      applyToGuardian,
      applyToMemory,
      hfModels: hfModels.length > 0 ? hfModels : undefined,
      composeOk: composeResult.ok,
    },
    composeResult.ok,
    requestId,
    callerType
  );

  return jsonResponse(200, {
    ok: true,
    pulling: composeResult.ok,
    downloading: hfModels.length > 0,
    modelRunnerUrl,
    composeResult: { ok: composeResult.ok, stderr: composeResult.stderr },
  }, requestId);
};

/**
 * DELETE /admin/models/local
 *
 * Remove one or all local model configurations.
 * Body: { model: "local-llm" | "local-embedding" } or { all: true }
 */
export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const callerType = getCallerType(event);
  const state = getState();
  const body = await parseJsonBody(event.request);

  const current = readLocalModelsCompose(state.dataDir, state.configDir);
  if (!current) {
    return jsonResponse(200, { ok: true, message: "No local models configured" }, requestId);
  }

  // Track which models are being removed for cleanup
  const removedModels: string[] = [];

  if (body.all === true) {
    // Collect all model IDs being removed
    if (current.systemModel) removedModels.push(current.systemModel.model);
    if (current.embeddingModel) removedModels.push(current.embeddingModel.model);
    writeLocalModelsCompose(state.dataDir, {});
  } else {
    const target = String(body.model ?? "");
    if (target === "local-llm" || target === "system") {
      if (current.systemModel) removedModels.push(current.systemModel.model);
      delete current.systemModel;
    } else if (target === "local-embedding" || target === "embedding") {
      if (current.embeddingModel) removedModels.push(current.embeddingModel.model);
      delete current.embeddingModel;
    } else {
      return errorResponse(400, "invalid_target", `Unknown model target: "${target}"`, {}, requestId);
    }
    // Detect URL for overlay when partial models remain
    const det = current.systemModel || current.embeddingModel
      ? await detectModelRunner()
      : { url: "" };
    writeLocalModelsCompose(state.dataDir, current, det.url);
  }

  // Prune metadata entries for removed models
  if (removedModels.length > 0) {
    const meta = readLocalModelsMeta(state.dataDir);
    for (const id of removedModels) {
      delete meta.models[id];
    }
    writeLocalModelsMeta(state.dataDir, meta);
  }

  // Clear model-related secrets when all local models removed
  if (!current.systemModel && !current.embeddingModel) {
    patchSecretsEnvFile(state.configDir, {
      SYSTEM_LLM_PROVIDER: "",
      SYSTEM_LLM_BASE_URL: "",
      SYSTEM_LLM_MODEL: "",
      OPENAI_BASE_URL: "",
      EMBEDDING_MODEL: "",
      EMBEDDING_DIMS: "",
    });
  }

  // Re-stage and reconcile compose
  state.artifacts = stageArtifacts(state);
  persistArtifacts(state);

  const composeResult = await composeUp(state.stateDir, {
    files: buildComposeFileList(state),
    envFiles: buildEnvFiles(state),
    services: buildManagedServices(state),
  });

  appendAudit(
    state,
    "models.local",
    "models.local.delete",
    { target: body.all ? "all" : body.model, composeOk: composeResult.ok },
    composeResult.ok,
    requestId,
    callerType
  );

  return jsonResponse(200, { ok: true }, requestId);
};
