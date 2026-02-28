import {
  getRequestId,
  jsonResponse,
  errorResponse,
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
import type { RequestHandler } from "./$types";

/**
 * Read secrets.env and return only which keys are set (non-empty),
 * never returning actual values.
 */
function readConfiguredKeys(): Record<string, boolean> {
  const state = getState();
  const secretsPath = `${state.configDir}/secrets.env`;
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
 * GET /admin/setup — no auth required.
 *
 * Returns which config keys are set (booleans only, never values)
 * and whether setup is complete (admin token exists).
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const state = getState();
  const keys = readConfiguredKeys();

  // Setup is complete when ADMIN_TOKEN has a value in secrets.env
  const setupComplete = keys.ADMIN_TOKEN === true;

  // Installed = any non-admin service is running
  const installed = Object.entries(state.services).some(
    ([name, status]) => name !== "admin" && status === "running"
  );

  return jsonResponse(
    200,
    {
      setupComplete,
      installed,
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
 * POST /admin/setup — no auth required.
 *
 * Saves configuration to secrets.env (including admin token) and
 * triggers the full-stack install.
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
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
  let dockerResult = null;
  if (dockerCheck.ok) {
    dockerResult = await composeUp(state.stateDir, {
      files: buildComposeFileList(state),
      envFiles: buildEnvFiles(state)
    });
  }

  // Audit log
  appendAudit(
    state,
    "setup",
    "setup.install",
    {
      dockerAvailable: dockerCheck.ok,
      composeResult: dockerResult?.ok ?? null,
      channels: channelNames
    },
    true,
    requestId,
    callerType
  );

  const started = [
    ...CORE_SERVICES,
    ...channelNames.map((name) => `channel-${name}`)
  ];

  return jsonResponse(
    200,
    {
      ok: true,
      started,
      dockerAvailable: dockerCheck.ok,
      composeResult: dockerResult
        ? { ok: dockerResult.ok, stderr: dockerResult.stderr }
        : null
    },
    requestId
  );
};
