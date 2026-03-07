import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  getCallerType,
  parseJsonBody,
  safeTokenCompare,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  updateSecretsEnv,
  ensureXdgDirs,
  ensureOpenCodeConfig,
  ensureOpenCodeSystemConfig,
  ensureMemoryDir,
  ensureSecrets,
  ensureConnectionProfilesStore,
  writeConnectionsDocument,
  applyInstall,
  appendAudit,
  discoverStagedChannelYmls,
  buildComposeFileList,
  buildEnvFiles,
  buildManagedServices,
  writeMemoryConfig,
  readMemoryConfig,
  resolveConfigForPush,
  pushConfigToMemory,
  provisionMemoryUser,
  buildMem0Mapping,
} from "$lib/server/control-plane.js";
import {
  PROVIDER_KEY_MAP,
  EMBEDDING_DIMS,
  OLLAMA_INSTACK_URL
} from "$lib/provider-constants.js";
import {
  isWizardProviderInScope,
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
        MEMORY_USER_ID: keys.MEMORY_USER_ID === true,
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

// ── POST body types ──────────────────────────────────────────────────────

type SetupConnection = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
};

type SetupAssignments = {
  llm: { connectionId: string; model: string; smallModel?: string };
  embeddings: { connectionId: string; model: string; embeddingDims?: number };
};

/**
 * POST /admin/setup
 *
 * Accepts multi-profile connections and per-capability assignments.
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const state = getState();
  const setupComplete = isSetupComplete(state.stateDir, state.configDir);

  if (setupComplete) {
    const authError = requireAdmin(event, requestId);
    if (authError) return authError;
  } else {
    const bootstrapToken = event.request.headers.get("x-admin-token") ?? "";
    if (!safeTokenCompare(bootstrapToken, state.setupToken)) {
      return errorResponse(401, "unauthorized", "Missing or invalid x-admin-token", {}, requestId);
    }
  }

  const callerType = getCallerType(event);
  logger.info("setup install request received", { requestId, setupComplete });

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, "invalid_input", "Request body must be valid JSON", {}, requestId);
  }

  // ── Parse and validate ────────────────────────────────────────────────

  const updates: Record<string, string> = {};
  if (typeof body.adminToken === "string" && body.adminToken) {
    updates.ADMIN_TOKEN = body.adminToken;
  }

  const ownerName = typeof body.ownerName === "string" ? body.ownerName.trim() : "";
  const ownerEmail = typeof body.ownerEmail === "string" ? body.ownerEmail.trim() : "";
  if (ownerName) updates.OWNER_NAME = ownerName;
  if (ownerEmail) updates.OWNER_EMAIL = ownerEmail;

  const memoryUserId = typeof body.memoryUserId === "string" ? body.memoryUserId : "default_user";
  const ollamaEnabled = body.ollamaEnabled === true;

  // ── Parse connections array ───────────────────────────────────────────

  if (!Array.isArray(body.connections) || body.connections.length === 0) {
    return errorResponse(400, "bad_request", "connections array is required and must be non-empty", {}, requestId);
  }

  const connections: SetupConnection[] = [];
  for (let i = 0; i < body.connections.length; i++) {
    const c = body.connections[i];
    if (typeof c !== 'object' || c === null) {
      return errorResponse(400, "bad_request", `connections[${i}] must be an object`, {}, requestId);
    }
    const id = typeof c.id === 'string' ? c.id.trim() : '';
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    const provider = typeof c.provider === 'string' ? c.provider.trim() : '';
    const baseUrl = typeof c.baseUrl === 'string' ? c.baseUrl : '';
    const apiKey = typeof c.apiKey === 'string' ? c.apiKey : '';

    if (!id) return errorResponse(400, "bad_request", `connections[${i}].id is required`, {}, requestId);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      return errorResponse(400, "bad_request", `connections[${i}].id contains invalid characters (allowed: A-Z, a-z, 0-9, _, -)`, {}, requestId);
    }
    if (!provider) return errorResponse(400, "bad_request", `connections[${i}].provider is required`, {}, requestId);
    if (!isWizardProviderInScope(provider)) {
      return errorResponse(400, "bad_request", `connections[${i}].provider "${provider}" is outside wizard scope`, {}, requestId);
    }

    connections.push({ id, name: name || provider, provider, baseUrl, apiKey });
  }

  // Check for duplicate IDs
  const connectionIds = new Set(connections.map((c) => c.id));
  if (connectionIds.size !== connections.length) {
    return errorResponse(400, "bad_request", "Duplicate connection IDs found", {}, requestId);
  }

  // ── Parse assignments ─────────────────────────────────────────────────

  if (typeof body.assignments !== 'object' || body.assignments === null) {
    return errorResponse(400, "bad_request", "assignments object is required", {}, requestId);
  }

  const rawAssignments = body.assignments as Record<string, unknown>;
  const llmAssignment = rawAssignments.llm;
  const embAssignment = rawAssignments.embeddings;

  if (typeof llmAssignment !== 'object' || llmAssignment === null) {
    return errorResponse(400, "bad_request", "assignments.llm is required", {}, requestId);
  }
  if (typeof embAssignment !== 'object' || embAssignment === null) {
    return errorResponse(400, "bad_request", "assignments.embeddings is required", {}, requestId);
  }

  const llm = llmAssignment as Record<string, unknown>;
  const emb = embAssignment as Record<string, unknown>;
  const llmConnectionId = typeof llm.connectionId === 'string' ? llm.connectionId : '';
  const llmModel = typeof llm.model === 'string' ? llm.model : '';
  const llmSmallModel = typeof llm.smallModel === 'string' ? llm.smallModel : '';
  const embConnectionId = typeof emb.connectionId === 'string' ? emb.connectionId : '';
  const embModel = typeof emb.model === 'string' ? emb.model : '';
  const embDims = typeof emb.embeddingDims === 'number' ? emb.embeddingDims : 0;

  if (!llmConnectionId || !llmModel) {
    return errorResponse(400, "bad_request", "assignments.llm requires connectionId and model", {}, requestId);
  }
  if (!embConnectionId || !embModel) {
    return errorResponse(400, "bad_request", "assignments.embeddings requires connectionId and model", {}, requestId);
  }
  if (!connectionIds.has(llmConnectionId)) {
    return errorResponse(400, "bad_request", `assignments.llm.connectionId "${llmConnectionId}" does not match any connection`, {}, requestId);
  }
  if (!connectionIds.has(embConnectionId)) {
    return errorResponse(400, "bad_request", `assignments.embeddings.connectionId "${embConnectionId}" does not match any connection`, {}, requestId);
  }
  if (embDims !== 0 && (!Number.isInteger(embDims) || embDims < 1)) {
    return errorResponse(400, "bad_request", "assignments.embeddings.embeddingDims must be a positive integer", {}, requestId);
  }

  const parsedAssignments: SetupAssignments = {
    llm: { connectionId: llmConnectionId, model: llmModel, ...(llmSmallModel ? { smallModel: llmSmallModel } : {}) },
    embeddings: { connectionId: embConnectionId, model: embModel, ...(embDims > 0 ? { embeddingDims: embDims } : {}) },
  };

  // ── Resolve effective base URLs (Ollama in-stack override) ────────────

  const effectiveConnections = connections.map((c) => {
    if (ollamaEnabled && c.provider === "ollama") {
      return { ...c, baseUrl: OLLAMA_INSTACK_URL };
    }
    return c;
  });

  // ── Build connectionId → envVarName map (single source of truth) ─────

  const connEnvVarMap = new Map<string, string>();
  const claimedEnvVars = new Set<string>();

  for (const conn of effectiveConnections) {
    let envVarName = PROVIDER_KEY_MAP[conn.provider] ?? "OPENAI_API_KEY";
    if (claimedEnvVars.has(envVarName)) {
      // Second connection with same provider — use namespaced var
      envVarName = `${envVarName}_${conn.id}`;
    }
    claimedEnvVars.add(envVarName);
    connEnvVarMap.set(conn.id, envVarName);
  }

  // ── Build secrets.env updates ─────────────────────────────────────────

  for (const conn of effectiveConnections) {
    if (!conn.apiKey) continue;
    updates[connEnvVarMap.get(conn.id)!] = conn.apiKey;
  }

  // Set SYSTEM_LLM_* from the LLM connection for env-level consumers
  const llmConnection = effectiveConnections.find((c) => c.id === llmConnectionId)!;
  updates.SYSTEM_LLM_PROVIDER = llmConnection.provider;
  updates.SYSTEM_LLM_MODEL = llmModel;
  if (llmConnection.baseUrl) {
    updates.SYSTEM_LLM_BASE_URL = llmConnection.baseUrl;
  }

  updates.MEMORY_USER_ID = memoryUserId;

  // ── Persist ───────────────────────────────────────────────────────────

  logger.info("persisting setup config", {
    requestId,
    connectionCount: connections.length,
    llmProvider: llmConnection.provider,
    llmModel,
    embModel,
  });

  try {
    ensureXdgDirs();
    ensureSecrets(state);
    ensureConnectionProfilesStore(state.configDir);
    updateSecretsEnv(state, updates);
  } catch (err) {
    logger.error("failed to update secrets.env", { requestId, error: String(err) });
    return errorResponse(500, "config_save_failed", `Failed to update secrets.env: ${err instanceof Error ? err.message : String(err)}`, {}, requestId);
  }

  if (updates.ADMIN_TOKEN) {
    state.adminToken = updates.ADMIN_TOKEN;
  }

  // ── Build and persist Memory config ───────────────────────────────

  const embConnection = effectiveConnections.find((c) => c.id === embConnectionId)!;

  const llmEnvVar = connEnvVarMap.get(llmConnection.id)!;
  const llmApiKeyEnvRef = llmConnection.apiKey ? `env:${llmEnvVar}` : "not-needed";

  const embEnvVar = connEnvVarMap.get(embConnection.id)!;
  const embApiKeyEnvRef = embConnection.apiKey ? `env:${embEnvVar}` : "not-needed";

  const embLookupKey = `${embConnection.provider}/${embModel}`;
  const resolvedDims = embDims || EMBEDDING_DIMS[embLookupKey] || 1536;

  const omConfig = buildMem0Mapping({
    llm: {
      provider: llmConnection.provider,
      baseUrl: llmConnection.baseUrl,
      model: llmModel,
      apiKeyRef: llmApiKeyEnvRef,
    },
    embedder: {
      provider: embConnection.provider,
      baseUrl: embConnection.baseUrl,
      model: embModel || 'text-embedding-3-small',
      apiKeyRef: embApiKeyEnvRef,
    },
    embeddingDims: resolvedDims,
    customInstructions: '',
  });

  writeMemoryConfig(state.dataDir, omConfig);

  // Build profiles input for writeConnectionsDocument
  const profilesInput = effectiveConnections.map((conn) => ({
    id: conn.id,
    name: conn.name,
    provider: conn.provider,
    baseUrl: conn.baseUrl,
    hasApiKey: Boolean(conn.apiKey),
    apiKeyEnvVar: connEnvVarMap.get(conn.id)!,
  }));

  writeConnectionsDocument(state.configDir, {
    profiles: profilesInput,
    assignments: {
      llm: parsedAssignments.llm,
      embeddings: {
        connectionId: parsedAssignments.embeddings.connectionId,
        model: parsedAssignments.embeddings.model,
        embeddingDims: resolvedDims,
      },
    },
  });

  // ── Install and deploy ────────────────────────────────────────────────

  ensureOpenCodeConfig();
  ensureOpenCodeSystemConfig();
  ensureMemoryDir();
  applyInstall(state);

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

  const managedServices = buildManagedServices(state);
  const started = [
    ...managedServices,
    ...channelNames.map((name) => `channel-${name}`)
  ];

  const SERVICE_LABELS: Record<string, string> = {
    caddy: "Caddy (reverse proxy)",
    memory: "Memory",
    assistant: "Assistant",
    guardian: "Guardian",
    ollama: "Ollama",
  };

  initDeployStatus(
    managedServices.map((s) => ({
      service: s,
      label: SERVICE_LABELS[s] ?? s,
    }))
  );

  void (async () => {
    const composeFiles = buildComposeFileList(state);
    const envFiles = buildEnvFiles(state);

    for (const service of managedServices) {
      const pullResult = await composePullService(state.stateDir, service, {
        files: composeFiles,
        envFiles,
      });
      if (pullResult.ok) {
        markImageReady(service);
      } else {
        logger.warn("pull returned non-zero for service, continuing", { service, stderr: pullResult.stderr });
        markImageReady(service);
      }
    }

    markAllImagesReady();

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

    const config = readMemoryConfig(state.dataDir);
    const resolved = resolveConfigForPush(config, state.configDir);
    const maxAttempts = 5;
    const delayMs = 10_000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await pushConfigToMemory(resolved);
      if (result.ok) {
        logger.info("pushed Memory config after setup install", { attempt });
        await provisionMemoryUser(memoryUserId);
        return;
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        logger.warn("failed to push Memory config after setup install", {
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
