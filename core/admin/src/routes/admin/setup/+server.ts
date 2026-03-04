import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  getCallerType,
  parseJsonBody,
  safeTokenCompare
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  updateSecretsEnv,
  ensureXdgDirs,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  ensureOpenMemoryPatch,
  ensureSecrets,
  applyInstall,
  appendAudit,
  discoverStagedChannelYmls,
  buildComposeFileList,
  buildEnvFiles,
  buildManagedServices,
  CORE_SERVICES,
  writeOpenMemoryConfig,
  readOpenMemoryConfig,
  resolveConfigForPush,
  pushConfigToOpenMemory,
  LOCAL_EMBEDDING_DIMS,
  detectModelRunner,
  writeLocalModelsCompose,
  patchSecretsEnvFile,
  type OpenMemoryConfig,
  type LocalModelSelection
} from "$lib/server/control-plane.js";
import { PROVIDER_KEY_MAP, EMBEDDING_DIMS } from "$lib/provider-constants.js";
import { composeUp, checkDocker } from "$lib/server/docker.js";
import { detectUserId, isSetupComplete, readSecretsKeys } from "$lib/server/setup-status.js";
import { createLogger } from "$lib/server/logger.js";
import type { RequestHandler } from "./$types";

const logger = createLogger("setup");

/**
 * GET /admin/setup — no auth required.
 *
 * Returns which config keys are set (booleans only, never values)
 * and whether setup is complete (admin token exists).
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const state = getState();
  const keys = readSecretsKeys(state.configDir);

  // Installed = any non-admin service is running
  const setupComplete = isSetupComplete(state.stateDir, state.configDir);
  const installed = Object.entries(state.services).some(
    ([name, status]) => name !== "admin" && status === "running"
  );

  return jsonResponse(
    200,
    {
      setupComplete,
      installed,
      ...(setupComplete ? {} : { setupToken: state.setupToken }),
      detectedUserId: detectUserId(),
      configured: {
        OPENAI_API_KEY: keys.OPENAI_API_KEY === true,
        OPENAI_BASE_URL: keys.OPENAI_BASE_URL === true,
        OPENMEMORY_USER_ID: keys.OPENMEMORY_USER_ID === true,
        GROQ_API_KEY: keys.GROQ_API_KEY === true,
        MISTRAL_API_KEY: keys.MISTRAL_API_KEY === true,
        GOOGLE_API_KEY: keys.GOOGLE_API_KEY === true
      }
    },
    requestId
  );
};

/**
 * POST /admin/setup
 *
 * Unauthenticated during first-run (ADMIN_TOKEN is empty).
 * Once a token has been set, requires normal admin auth — prevents
 * callers from rotating the token or re-running install without auth.
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const state = getState();
  const setupComplete = isSetupComplete(state.stateDir, state.configDir);

  if (setupComplete) {
    // Setup already completed — require normal admin auth
    const authError = requireAdmin(event, requestId);
    if (authError) return authError;
  } else {
    // First-run setup requires the ephemeral setup token from GET /admin/setup
    const bootstrapToken = event.request.headers.get("x-admin-token") ?? "";
    if (!safeTokenCompare(bootstrapToken, state.setupToken)) {
      return errorResponse(
        401,
        "unauthorized",
        "Missing or invalid x-admin-token",
        {},
        requestId
      );
    }
  }

  const callerType = getCallerType(event);
  const body = await parseJsonBody(event.request);

  // Build update map from request body
  const updates: Record<string, string> = {};
  if (typeof body.adminToken === "string" && body.adminToken) {
    updates.ADMIN_TOKEN = body.adminToken;
  }

  // ── System LLM connection fields (new wizard) ──
  const llmProvider = (body.llmProvider as string) ?? "";
  const llmApiKey = (body.llmApiKey as string) ?? "";
  const llmBaseUrl = (body.llmBaseUrl as string) ?? "";
  const guardianModel = (body.guardianModel as string) ?? "";
  const memoryModel = (body.memoryModel as string) ?? "";
  const embeddingModel = (body.embeddingModel as string) ?? "";
  const embeddingDims = typeof body.embeddingDims === "number" ? body.embeddingDims : 0;
  const openmemoryUserId = (body.openmemoryUserId as string) ?? "default_user";

  if (llmApiKey) {
    const envVarName = PROVIDER_KEY_MAP[llmProvider] ?? "OPENAI_API_KEY";
    updates[envVarName] = llmApiKey;
  }

  // Legacy fallback: accept old openaiApiKey field
  if (!llmApiKey && typeof body.openaiApiKey === "string" && body.openaiApiKey) {
    updates.OPENAI_API_KEY = body.openaiApiKey;
  }
  if (typeof body.openaiBaseUrl === "string") {
    updates.OPENAI_BASE_URL = body.openaiBaseUrl;
  }

  if (guardianModel) {
    updates.GUARDIAN_LLM_PROVIDER = llmProvider || "openai";
    updates.GUARDIAN_LLM_MODEL = guardianModel;
  }

  updates.OPENMEMORY_USER_ID = openmemoryUserId;

  // Ensure directories and secrets.env exist before updating
  try {
    ensureXdgDirs();
    ensureSecrets(state);
    updateSecretsEnv(state, updates);
  } catch (err) {
    return errorResponse(
      500,
      "config_save_failed",
      `Failed to update secrets.env: ${err instanceof Error ? err.message : String(err)}`,
      {},
      requestId
    );
  }

  // If admin token was set, update in-memory state so subsequent
  // authenticated endpoints work immediately
  if (updates.ADMIN_TOKEN) {
    state.adminToken = updates.ADMIN_TOKEN;
  }

  // Build and persist OpenMemory config from wizard selections
  if (llmProvider && memoryModel) {
    const apiKeyEnvRef = PROVIDER_KEY_MAP[llmProvider]
      ? `env:${PROVIDER_KEY_MAP[llmProvider]}`
      : llmApiKey; // raw key if no standard env var

    const llmConfig: Record<string, unknown> = {
      model: memoryModel,
      temperature: 0.1,
      max_tokens: 2000,
      api_key: apiKeyEnvRef,
    };
    if (llmBaseUrl.trim()) llmConfig.base_url = llmBaseUrl.trim();

    // Embedding provider — for now same provider as LLM
    const embedApiKeyRef = apiKeyEnvRef;
    const embedConfig: Record<string, unknown> = {
      model: embeddingModel || "text-embedding-3-small",
      api_key: embedApiKeyRef,
    };
    if (llmBaseUrl.trim()) embedConfig.base_url = llmBaseUrl.trim();

    // Resolve embedding dimensions
    const lookupKey = `${llmProvider}/${embeddingModel}`;
    const resolvedDims = embeddingDims || EMBEDDING_DIMS[lookupKey] || 1536;

    const omConfig: OpenMemoryConfig = {
      mem0: {
        llm: { provider: llmProvider, config: llmConfig },
        embedder: { provider: llmProvider, config: embedConfig },
        vector_store: {
          provider: "qdrant",
          config: {
            collection_name: "openmemory",
            path: "/data/qdrant",
            embedding_model_dims: resolvedDims,
          },
        },
      },
      openmemory: { custom_instructions: "" },
    };

    writeOpenMemoryConfig(state.dataDir, omConfig);
  }

  // ── Local model configuration (Docker Model Runner) ──
  const localSystemModel = (body.localSystemModel as string) ?? "";
  const localEmbeddingModel = (body.localEmbeddingModel as string) ?? "";
  const localEmbeddingDims = typeof body.localEmbeddingDims === "number"
    ? body.localEmbeddingDims
    : (localEmbeddingModel ? (LOCAL_EMBEDDING_DIMS[localEmbeddingModel] ?? 384) : 0);

  if (localSystemModel || localEmbeddingModel) {
    const selection: LocalModelSelection = {};

    if (localSystemModel) {
      selection.systemModel = { model: localSystemModel, contextSize: 4096 };
    }
    if (localEmbeddingModel) {
      selection.embeddingModel = { model: localEmbeddingModel, dimensions: localEmbeddingDims };
    }

    // Write CONFIG_HOME/local-models.yml compose overlay
    writeLocalModelsCompose(state.configDir, selection);

    // Detect Model Runner and apply local models to guardian/openmemory
    const detection = await detectModelRunner();
    if (detection.available) {
      // Apply system model to Guardian
      if (localSystemModel) {
        patchSecretsEnvFile(state.configDir, {
          GUARDIAN_LLM_PROVIDER: "openai",
          GUARDIAN_LLM_MODEL: localSystemModel,
          SYSTEM_LLM_BASE_URL: detection.url,
        });
      }

      // Apply local models to OpenMemory config
      const omConfigForLocal = readOpenMemoryConfig(state.dataDir);

      if (localSystemModel) {
        omConfigForLocal.mem0.llm = {
          provider: "openai",
          config: {
            model: localSystemModel,
            base_url: detection.url,
            api_key: "not-needed",
            temperature: 0.1,
            max_tokens: 2000,
          },
        };
      }

      if (localEmbeddingModel) {
        omConfigForLocal.mem0.embedder = {
          provider: "openai",
          config: {
            model: localEmbeddingModel,
            base_url: detection.url,
            api_key: "not-needed",
          },
        };
        omConfigForLocal.mem0.vector_store.config.embedding_model_dims = localEmbeddingDims;
      }

      writeOpenMemoryConfig(state.dataDir, omConfigForLocal);
    }
  }

  // Run install sequence
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
  ensureOpenMemoryPatch();
  applyInstall(state);

  // Discover staged channels and register them
  const stagedYmls = discoverStagedChannelYmls(state.stateDir);
  const channelNames = stagedYmls
    .map((p) => {
      const filename = p.split("/").pop() ?? "";
      return filename.replace(/\.yml$/, "");
    })
    .filter(Boolean);
  for (const name of channelNames) {
    const serviceName = `channel-${name}`;
    if (!(serviceName in state.services)) {
      state.services[serviceName] = "stopped";
    }
  }

  // Check Docker and run compose up
  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    appendAudit(
      state, "setup", "setup.install",
      { dockerAvailable: false, composeResult: null, channels: channelNames },
      false, requestId, callerType
    );
    return errorResponse(
      503,
      "docker_unavailable",
      "Docker is not available. Install or start Docker and retry.",
      { stderr: dockerCheck.stderr },
      requestId
    );
  }

  const dockerResult = await composeUp(state.stateDir, {
    files: buildComposeFileList(state),
    envFiles: buildEnvFiles(state),
    services: buildManagedServices(state)
  });

  const started = [
    ...CORE_SERVICES,
    ...channelNames.map((name) => `channel-${name}`)
  ];

  appendAudit(
    state, "setup", "setup.install",
    {
      dockerAvailable: true,
      composeResult: dockerResult.ok,
      channels: channelNames
    },
    dockerResult.ok,
    requestId,
    callerType
  );

  if (!dockerResult.ok) {
    return errorResponse(
      502,
      "compose_failed",
      `Docker Compose failed to start services: ${dockerResult.stderr}`,
      { stderr: dockerResult.stderr },
      requestId
    );
  }

  // Fire-and-forget: push resolved OpenMemory config to the running container.
  // OpenMemory may take time to start, so retry with delays.
  void (async () => {
    const config = readOpenMemoryConfig(state.dataDir);
    const resolved = resolveConfigForPush(config, state.configDir);
    const maxAttempts = 5;
    const delayMs = 10_000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await pushConfigToOpenMemory(resolved);
      if (result.ok) {
        logger.info("pushed OpenMemory config after setup install", { attempt });
        return;
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        logger.warn("failed to push OpenMemory config after setup install", {
          attempts: maxAttempts,
          error: result.error
        });
      }
    }
  })();

  return jsonResponse(
    200,
    {
      ok: true,
      started,
      dockerAvailable: true,
      composeResult: { ok: true, stderr: dockerResult.stderr }
    },
    requestId
  );
};
