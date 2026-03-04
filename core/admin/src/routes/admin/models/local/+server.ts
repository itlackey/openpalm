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
import type { RequestHandler } from "./$types";

/**
 * GET /admin/models/local
 *
 * Returns Model Runner availability, current config, suggested models,
 * and list of already-pulled models.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const [detection, config] = await Promise.all([
    detectModelRunner(),
    Promise.resolve(readLocalModelsCompose(state.configDir)),
  ]);

  const pulledModels = detection.available
    ? await listPulledModels(detection.url)
    : [];

  return jsonResponse(200, {
    modelRunnerAvailable: detection.available,
    modelRunnerUrl: detection.url,
    config,
    suggestedSystemModels: SUGGESTED_SYSTEM_MODELS,
    suggestedEmbeddingModels: SUGGESTED_EMBEDDING_MODELS,
    embeddingDims: LOCAL_EMBEDDING_DIMS,
    pulledModels,
  }, requestId);
};

/**
 * POST /admin/models/local
 *
 * Save local model configuration. Writes CONFIG_HOME/local-models.yml,
 * re-stages artifacts, and runs compose up to trigger model pulling.
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
      selection.systemModel = {
        model,
        contextSize: typeof sm.contextSize === "number" ? sm.contextSize : undefined,
      };
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
      selection.embeddingModel = { model, dimensions: dims };
    }
  }

  // Write compose overlay
  writeLocalModelsCompose(state.configDir, selection);

  // Detect Model Runner URL for config updates
  const detection = await detectModelRunner();
  const modelRunnerUrl = detection.url;

  // Apply to Guardian config if requested
  const applyToGuardian = body.applyToGuardian === true;
  if (applyToGuardian && selection.systemModel && modelRunnerUrl) {
    patchSecretsEnvFile(state.configDir, {
      GUARDIAN_LLM_PROVIDER: "openai",
      GUARDIAN_LLM_MODEL: selection.systemModel.model,
      SYSTEM_LLM_BASE_URL: modelRunnerUrl,
    });
  }

  // Apply to OpenMemory config if requested
  const applyToMemory = body.applyToMemory === true;
  if (applyToMemory && modelRunnerUrl) {
    const omConfig = readOpenMemoryConfig(state.dataDir);

    if (selection.systemModel) {
      omConfig.mem0.llm = {
        provider: "openai",
        config: {
          model: selection.systemModel.model,
          base_url: modelRunnerUrl,
          api_key: "not-needed",
          temperature: 0.1,
          max_tokens: 2000,
        },
      };
    }

    if (selection.embeddingModel) {
      omConfig.mem0.embedder = {
        provider: "openai",
        config: {
          model: selection.embeddingModel.model,
          base_url: modelRunnerUrl,
          api_key: "not-needed",
        },
      };
      omConfig.mem0.vector_store.config.embedding_model_dims = selection.embeddingModel.dimensions;
    }

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

  // Run compose up to trigger model pulling
  const composeResult = await composeUp(state.stateDir, {
    files: buildComposeFileList(state),
    envFiles: buildEnvFiles(state),
    services: buildManagedServices(state),
  });

  appendAudit(
    state,
    "models.local",
    "models.local.save",
    {
      systemModel: selection.systemModel?.model ?? null,
      embeddingModel: selection.embeddingModel?.model ?? null,
      applyToGuardian,
      applyToMemory,
      composeOk: composeResult.ok,
    },
    composeResult.ok,
    requestId,
    callerType
  );

  return jsonResponse(200, {
    ok: true,
    pulling: composeResult.ok,
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

  const current = readLocalModelsCompose(state.configDir);
  if (!current) {
    return jsonResponse(200, { ok: true, message: "No local models configured" }, requestId);
  }

  if (body.all === true) {
    // Remove all local models
    writeLocalModelsCompose(state.configDir, {});
  } else {
    const target = String(body.model ?? "");
    if (target === "local-llm" || target === "system") {
      delete current.systemModel;
    } else if (target === "local-embedding" || target === "embedding") {
      delete current.embeddingModel;
    } else {
      return errorResponse(400, "invalid_target", `Unknown model target: "${target}"`, {}, requestId);
    }
    writeLocalModelsCompose(state.configDir, current);
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
