import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  getActor,
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

/** Read current config values from secrets.env for the setup wizard. */
function readCurrentConfig(): {
  openaiApiKey: string;
  openaiBaseUrl: string;
  openmemoryUserId: string;
} {
  const state = getState();
  const secretsPath = `${state.configDir}/secrets.env`;
  const values: Record<string, string> = {};

  if (existsSync(secretsPath)) {
    const content = readFileSync(secretsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      values[key] = trimmed.slice(eq + 1).trim();
    }
  }

  return {
    openaiApiKey: values.OPENAI_API_KEY ?? "",
    openaiBaseUrl: values.OPENAI_BASE_URL ?? "",
    openmemoryUserId: values.OPENMEMORY_USER_ID ?? "default_user"
  };
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const config = readCurrentConfig();

  // Installed = any non-admin service is running
  const installed = Object.entries(state.services).some(
    ([name, status]) => name !== "admin" && status === "running"
  );

  return jsonResponse(200, { ...config, installed }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  const body = await parseJsonBody(event.request);

  // 1. Build update map from request body
  const updates: Record<string, string> = {};
  if (typeof body.openaiApiKey === "string") {
    updates.OPENAI_API_KEY = body.openaiApiKey;
  }
  if (typeof body.openaiBaseUrl === "string") {
    updates.OPENAI_BASE_URL = body.openaiBaseUrl;
  }
  if (typeof body.openmemoryUserId === "string") {
    updates.OPENMEMORY_USER_ID = body.openmemoryUserId;
  }

  // 2. Save configuration to secrets.env
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

  // 3. Run install sequence
  ensureOpenCodeConfig();
  applyInstall(state);

  // 4. Discover staged channels and register them
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

  // 5. Check Docker and run compose up
  const dockerCheck = await checkDocker();
  let dockerResult = null;
  if (dockerCheck.ok) {
    dockerResult = await composeUp(state.stateDir, {
      files: buildComposeFileList(state),
      envFiles: buildEnvFiles(state)
    });
  }

  // 6. Audit log
  appendAudit(
    state,
    actor,
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
