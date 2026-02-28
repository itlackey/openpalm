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
  updateSecretsEnv,
  ensureXdgDirs,
  ensureOpenCodeConfig,
  ensureSecrets,
  applyInstall,
  appendAudit,
  discoverStagedChannelYmls,
  buildComposeFileList,
  buildEnvFiles,
  CORE_SERVICES
} from "$lib/server/control-plane.js";
import { composeUp, checkDocker } from "$lib/server/docker.js";
import { detectUserId, isSetupComplete, readSecretsKeys } from "$lib/server/setup-status.js";
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "./$types";

function safeTokenCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

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
  if (typeof body.openaiApiKey === "string") {
    updates.OPENAI_API_KEY = body.openaiApiKey;
  }
  if (typeof body.openaiBaseUrl === "string") {
    updates.OPENAI_BASE_URL = body.openaiBaseUrl;
  }
  if (typeof body.openmemoryUserId === "string") {
    updates.OPENMEMORY_USER_ID = body.openmemoryUserId;
  }

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

  // Run install sequence
  ensureOpenCodeConfig();
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
    envFiles: buildEnvFiles(state)
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
