import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  getCallerType,
  parseJsonBody,
  safeTokenCompare,
  parseCanonicalConnectionProfile,
  parseCapabilityAssignments,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  updateSecretsEnv,
  ensureXdgDirs,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  ensureOpenMemoryDir,
  ensureSecrets,
  ensureConnectionProfilesStore,
  writePrimaryConnectionProfile,
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
  buildMem0Mapping,
  readConnectionMigrationFlags,
  detectConnectionCompatibilityMode,
} from "$lib/server/control-plane.js";
import {
  PROVIDER_KEY_MAP,
  EMBEDDING_DIMS,
  mem0BaseUrlConfig,
  OLLAMA_INSTACK_URL
} from "$lib/provider-constants.js";
import {
  isWizardProviderInScope,
  validateWizardCapabilitiesInput,
} from '$lib/setup-wizard/scope.js';
import { composeUp, composePullService, checkDocker } from "$lib/server/docker.js";
import { detectUserId, isSetupComplete, readSecretsKeys } from "$lib/server/setup-status.js";
import { createLogger } from "$lib/server/logger.js";
import {
  initDeployStatus,
  markImageReady,
  markAllImagesReady,
  markAllRunning,
  markDeployError,
} from "$lib/server/deploy-tracker.js";
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
  logger.info("setup status check", { requestId });
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
        GOOGLE_API_KEY: keys.GOOGLE_API_KEY === true,
        OWNER_NAME: keys.OWNER_NAME === true,
        OWNER_EMAIL: keys.OWNER_EMAIL === true,
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
  logger.info("setup install request received", { requestId, setupComplete });

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, "invalid_input", "Request body must be valid JSON", {}, requestId);
  }

  const migrationFlags = readConnectionMigrationFlags();
  const compatibilityMode = detectConnectionCompatibilityMode(body);

  // Build update map from request body
  const updates: Record<string, string> = {};
  if (typeof body.adminToken === "string" && body.adminToken) {
    updates.ADMIN_TOKEN = body.adminToken;
  }

  // ── Owner identity fields ──
  const ownerName = typeof body.ownerName === "string" ? body.ownerName.trim() : "";
  const ownerEmail = typeof body.ownerEmail === "string" ? body.ownerEmail.trim() : "";
  if (ownerName) updates.OWNER_NAME = ownerName;
  if (ownerEmail) updates.OWNER_EMAIL = ownerEmail;

  // ── System LLM connection fields (new wizard) ──
  let llmProvider = typeof body.llmProvider === "string" ? body.llmProvider : "";
  const llmApiKey = typeof body.llmApiKey === "string" ? body.llmApiKey : (typeof body.apiKey === 'string' ? body.apiKey : '');
  let llmBaseUrl = typeof body.llmBaseUrl === "string" ? body.llmBaseUrl : "";
  let systemModel = typeof body.systemModel === "string" ? body.systemModel : "";
  let embeddingModel = typeof body.embeddingModel === "string" ? body.embeddingModel : "";
  let embeddingDims = typeof body.embeddingDims === "number" ? body.embeddingDims : 0;
  const openmemoryUserId = typeof body.openmemoryUserId === "string" ? body.openmemoryUserId : "default_user";
  const ollamaEnabled = body.ollamaEnabled === true;

  if (Array.isArray(body.profiles) && typeof body.assignments === 'object' && body.assignments !== null) {
    const profileParsed = parseCanonicalConnectionProfile(body.profiles[0]);
    if (!profileParsed.ok) {
      return errorResponse(400, 'bad_request', profileParsed.message, {}, requestId);
    }
    const assignmentParsed = parseCapabilityAssignments(body.assignments);
    if (!assignmentParsed.ok) {
      return errorResponse(400, 'bad_request', assignmentParsed.message, {}, requestId);
    }

    llmProvider = profileParsed.value.provider;
    llmBaseUrl = profileParsed.value.baseUrl;
    systemModel = assignmentParsed.value.llm.model;
    embeddingModel = assignmentParsed.value.embeddings.model;
    embeddingDims = assignmentParsed.value.embeddings.embeddingDims ?? 0;
  }

  if (llmProvider && !isWizardProviderInScope(llmProvider)) {
    return errorResponse(
      400,
      'bad_request',
      `Provider \"${llmProvider}\" is outside setup wizard v1 scope`,
      {},
      requestId
    );
  }

  const capabilitiesValidation = validateWizardCapabilitiesInput(body.capabilities);
  if (!capabilitiesValidation.ok) {
    return errorResponse(400, 'bad_request', capabilitiesValidation.message, {}, requestId);
  }

  // When Ollama runs in-stack, override base URL to use Docker network name
  const effectiveBaseUrl = (ollamaEnabled && llmProvider === "ollama")
    ? OLLAMA_INSTACK_URL
    : llmBaseUrl;

  if (llmApiKey) {
    const envVarName = PROVIDER_KEY_MAP[llmProvider] ?? "OPENAI_API_KEY";
    updates[envVarName] = llmApiKey;
  }

  if (systemModel) {
    updates.SYSTEM_LLM_PROVIDER = llmProvider || "openai";
    updates.SYSTEM_LLM_MODEL = systemModel;
  }
  if (effectiveBaseUrl) {
    updates.SYSTEM_LLM_BASE_URL = effectiveBaseUrl;
    const mem0Url = mem0BaseUrlConfig(llmProvider, effectiveBaseUrl);
    if (mem0Url?.key === "openai_base_url") {
      // OPENAI_BASE_URL is read by the openmemory container as env var fallback
      // for OpenAI-protocol providers. Ollama reads ollama_base_url from config.
      updates.OPENAI_BASE_URL = mem0Url.value;
    }
  }

  updates.OPENMEMORY_USER_ID = openmemoryUserId;

  // ── All validation passed — persist changes ──
  logger.info("persisting setup config", { requestId, provider: llmProvider, systemModel, embeddingModel });
  try {
    ensureXdgDirs();
    ensureSecrets(state);
    ensureConnectionProfilesStore(state.configDir);
    updateSecretsEnv(state, updates);
  } catch (err) {
    logger.error("failed to update secrets.env", { requestId, error: String(err) });
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

    // Resolve embedding dimensions
    const lookupKey = `${llmProvider}/${embeddingModel}`;
    const resolvedDims = embeddingDims || EMBEDDING_DIMS[lookupKey] || 1536;

    const omConfig = buildMem0Mapping({
      provider: llmProvider,
      baseUrl: effectiveBaseUrl,
      systemModel,
      embeddingModel: embeddingModel || 'text-embedding-3-small',
      embeddingDims: resolvedDims,
      apiKeyRef: apiKeyEnvRef,
      customInstructions: '',
    });

    writeOpenMemoryConfig(state.dataDir, omConfig);

    writePrimaryConnectionProfile(state.configDir, {
      provider: llmProvider,
      baseUrl: effectiveBaseUrl,
      systemModel,
      embeddingModel: embeddingModel || 'text-embedding-3-small',
      embeddingDims: resolvedDims,
    });
  }

  // Run install sequence
  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
  ensureOpenMemoryDir();
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

  // Check Docker before starting background deploy
  logger.info("checking Docker availability", { requestId });
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

  // Build the list of services that will be deployed
  const managedServices = buildManagedServices(state);
  const started = [
    ...managedServices,
    ...channelNames.map((name) => `channel-${name}`)
  ];

  // Friendly labels for the deploy progress UI
  const SERVICE_LABELS: Record<string, string> = {
    caddy: "Caddy (reverse proxy)",
    openmemory: "OpenMemory",
    assistant: "Assistant",
    guardian: "Guardian",
    ollama: "Ollama",
  };

  // Initialize per-service deploy tracking
  initDeployStatus(
    managedServices.map((s) => ({
      service: s,
      label: SERVICE_LABELS[s] ?? s,
    }))
  );

  // Fire-and-forget: pull images per-service, then compose up, then push config.
  void (async () => {
    const composeFiles = buildComposeFileList(state);
    const envFiles = buildEnvFiles(state);

    // Pull images one service at a time so the UI can show per-service progress
    for (const service of managedServices) {
      const pullResult = await composePullService(state.stateDir, service, {
        files: composeFiles,
        envFiles,
      });
      if (pullResult.ok) {
        markImageReady(service);
      } else {
        // Image might already be cached locally — mark ready and let compose up handle errors
        logger.warn("pull returned non-zero for service, continuing", { service, stderr: pullResult.stderr });
        markImageReady(service);
      }
    }

    markAllImagesReady();

    // Start all services
    const dockerResult = await composeUp(state.stateDir, {
      files: composeFiles,
      envFiles,
      services: managedServices,
      forceRecreate: true,
    });

    appendAudit(
      state, "setup", "setup.install",
      {
        dockerAvailable: true,
        composeResult: dockerResult.ok,
        channels: channelNames,
        ...(migrationFlags.annotateAudit ? { compatibilityMode } : {}),
      },
      dockerResult.ok,
      requestId,
      callerType
    );

    if (!dockerResult.ok) {
      logger.error("compose failed during setup", { requestId, stderr: dockerResult.stderr });
      markDeployError(`Docker Compose failed: ${dockerResult.stderr}`);
      return;
    }

    markAllRunning();

    // Push OpenMemory config with retries (container may take time to start)
    const config = readOpenMemoryConfig(state.dataDir);
    const resolved = resolveConfigForPush(config, state.configDir);
    const maxAttempts = 5;
    const delayMs = 10_000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await pushConfigToOpenMemory(resolved);
      if (result.ok) {
        logger.info("pushed OpenMemory config after setup install", { attempt });
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

  logger.info("setup deploy started in background", { requestId, started });

  return jsonResponse(
    200,
    {
      ok: true,
      async: true,
      started,
      dockerAvailable: true,
    },
    requestId
  );
};
