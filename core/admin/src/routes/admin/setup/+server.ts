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
  writeOpenMemoryConfig,
  readOpenMemoryConfig,
  resolveConfigForPush,
  pushConfigToOpenMemory,
  provisionOpenMemoryUser,
  type OpenMemoryConfig
} from "$lib/server/control-plane.js";
import { PROVIDER_KEY_MAP, EMBEDDING_DIMS, mem0ProviderName } from "$lib/provider-constants.js";
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
  const systemModel = (body.systemModel as string) ?? (body.guardianModel as string) ?? "";
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

  if (systemModel) {
    updates.SYSTEM_LLM_PROVIDER = llmProvider || "openai";
    updates.SYSTEM_LLM_MODEL = systemModel;
  }
  if (llmBaseUrl) {
    updates.SYSTEM_LLM_BASE_URL = llmBaseUrl;
    // OPENAI_BASE_URL is read by the openmemory container as env var fallback
    updates.OPENAI_BASE_URL = `${llmBaseUrl.replace(/\/+$/, "")}/v1`;
  }

  updates.OPENMEMORY_USER_ID = openmemoryUserId;

  // ── All validation passed — persist changes ──
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
  if (llmProvider && systemModel) {
    const apiKeyEnvRef = PROVIDER_KEY_MAP[llmProvider]
      ? `env:${PROVIDER_KEY_MAP[llmProvider]}`
      : (llmApiKey || "not-needed");

    const llmConfig: Record<string, unknown> = {
      model: systemModel,
      temperature: 0.1,
      max_tokens: 2000,
      api_key: apiKeyEnvRef,
    };
    if (llmBaseUrl.trim()) llmConfig.openai_base_url = `${llmBaseUrl.trim().replace(/\/+$/, "")}/v1`;

    // Embedding provider — for now same provider as LLM
    const embedApiKeyRef = apiKeyEnvRef;
    const embedConfig: Record<string, unknown> = {
      model: embeddingModel || "text-embedding-3-small",
      api_key: embedApiKeyRef,
    };
    if (llmBaseUrl.trim()) embedConfig.openai_base_url = `${llmBaseUrl.trim().replace(/\/+$/, "")}/v1`;

    // Resolve embedding dimensions
    const lookupKey = `${llmProvider}/${embeddingModel}`;
    const resolvedDims = embeddingDims || EMBEDDING_DIMS[lookupKey] || 1536;

    const omConfig: OpenMemoryConfig = {
      mem0: {
        llm: { provider: mem0ProviderName(llmProvider), config: llmConfig },
        embedder: { provider: mem0ProviderName(llmProvider), config: embedConfig },
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
    services: buildManagedServices(state),
    forceRecreate: true,
  });

  const started = [
    ...buildManagedServices(state),
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

  // Fire-and-forget: push resolved OpenMemory config and provision user.
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
        // Provision the user so memory-add doesn't get "User not found"
        await provisionOpenMemoryUser(openmemoryUserId);
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
