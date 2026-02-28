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
import { readFileSync, existsSync } from "node:fs";
import { userInfo } from "node:os";
import type { RequestHandler } from "./$types";

/**
 * Read secrets.env directly (without getState()) and return which keys
 * have non-empty values. Uses resolveConfigHome() logic inline so this
 * works even before state is fully initialized.
 */
function readSecretsKeys(): Record<string, boolean> {
  const configDir =
    process.env.OPENPALM_CONFIG_HOME ??
    `${process.env.HOME ?? "/tmp"}/.config/openpalm`;
  const secretsPath = `${configDir}/secrets.env`;
  const result: Record<string, boolean> = {};

  if (existsSync(secretsPath)) {
    const content = readFileSync(secretsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      result[key] = value.length > 0;
    }
  }

  return result;
}

/**
 * Detect the current system user login name for use as default OpenMemory user ID.
 * Tries environment variables first, then falls back to os.userInfo().
 */
function detectUserId(): string {
  const envUser = process.env.USER ?? process.env.LOGNAME ?? "";
  if (envUser) return envUser;
  try {
    return userInfo().username || "default_user";
  } catch {
    return "default_user";
  }
}

/**
 * Check whether the admin token has been set (non-empty) in secrets.env.
 * When true, setup is complete and the POST endpoint requires auth.
 */
function isSetupComplete(): boolean {
  const keys = readSecretsKeys();
  return keys.ADMIN_TOKEN === true;
}

/**
 * GET /admin/setup — no auth required.
 *
 * Returns which config keys are set (booleans only, never values)
 * and whether setup is complete (admin token exists).
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const keys = readSecretsKeys();

  const setupComplete = keys.ADMIN_TOKEN === true;

  // Installed = any non-admin service is running
  const state = getState();
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

  // One-time guard: if setup is already complete, require admin auth
  if (isSetupComplete()) {
    const authError = requireAdmin(event, requestId);
    if (authError) return authError;
  }

  const state = getState();
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
      {},
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
