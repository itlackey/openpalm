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
  appendAudit,
  discoverStagedChannelYmls,
  buildComposeFileList,
  buildEnvFiles,
  buildManagedServices,
  readMemoryConfig,
  resolveConfigForPush,
  pushConfigToMemory,
  provisionMemoryUser,
} from "$lib/server/control-plane.js";
import { viteAssets } from "$lib/server/vite-asset-provider.js";
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
import { performSetup, validateSetupInput } from "@openpalm/lib";
import type { SetupInput } from "@openpalm/lib";
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

/**
 * POST /admin/setup
 *
 * Delegates to performSetup() from @openpalm/lib for secrets, connections,
 * memory config, and artifact staging. Then handles the admin-specific
 * Docker deployment (compose pull + up) in the background.
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

  // ── Map request body to SetupInput ──────────────────────────────────

  const setupInput: SetupInput = {
    adminToken: typeof body.adminToken === "string" ? body.adminToken : state.adminToken,
    ownerName: typeof body.ownerName === "string" ? body.ownerName : undefined,
    ownerEmail: typeof body.ownerEmail === "string" ? body.ownerEmail : undefined,
    memoryUserId: typeof body.memoryUserId === "string" ? body.memoryUserId : "default_user",
    ollamaEnabled: body.ollamaEnabled === true,
    connections: Array.isArray(body.connections) ? body.connections : [],
    assignments: typeof body.assignments === "object" && body.assignments !== null
      ? body.assignments as SetupInput["assignments"]
      : { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
  };

  // ── Validate early so we return structured errors ───────────────────

  const validation = validateSetupInput(setupInput);
  if (!validation.valid) {
    return errorResponse(400, "bad_request", validation.errors.join("; "), {}, requestId);
  }

  // ── Delegate to performSetup() from lib ─────────────────────────────

  const setupResult = await performSetup(setupInput, viteAssets, { state });

  if (!setupResult.ok) {
    logger.error("performSetup failed", { requestId, error: setupResult.error });
    return errorResponse(500, "config_save_failed", setupResult.error ?? "Setup failed", {}, requestId);
  }

  // ── Post-setup: discover channels and update state ──────────────────

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

  // ── Docker deployment ───────────────────────────────────────────────

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
  const started = [...managedServices];

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

  const memoryUserId = setupInput.memoryUserId;

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
