/**
 * POST /admin/setup/ollama — Enable Ollama in the compose stack (async).
 *
 * Returns immediately after starting the Ollama container. Model pulling
 * happens in the background. The UI polls GET /admin/setup/ollama for status.
 *
 * GET /admin/setup/ollama — Poll Ollama background enable status.
 *
 * Auth: setup token during wizard, admin token after setup.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  getRequestId,
  requireAdminOrSetupToken,
} from "$lib/server/helpers.js";
import { ensureOllamaCompose } from "$lib/server/core-assets.js";
import { composeUp, checkDocker } from "$lib/server/docker.js";
import {
  buildComposeFileList
} from "$lib/server/lifecycle.js";
import {
  ensureXdgDirs,
  stageArtifacts,
  persistArtifacts,
  buildEnvFiles
} from "$lib/server/control-plane.js";
import { OLLAMA_DEFAULT_MODELS } from "$lib/provider-constants.js";
import { createLogger } from "$lib/server/logger.js";
import { mergeEnvContent } from "$lib/server/env.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const logger = createLogger("setup-ollama");

// ── In-memory background task state ─────────────────────────────────────
type OllamaTaskStatus = {
  phase: "starting" | "waiting" | "pulling" | "done" | "error";
  message: string;
  ollamaUrl: string;
  models: Record<string, { ok: boolean; error?: string }>;
  allModelsPulled: boolean;
  defaultChatModel: string;
  defaultEmbeddingModel: string;
};

let ollamaTask: OllamaTaskStatus | null = null;
let ollamaTaskRunning = false;

/** Clear stale task state so GET stops returning active: true. */
function clearOllamaTask(): void {
  ollamaTask = null;
}

/** Pull a model from Ollama via its HTTP API. */
async function pullOllamaModel(
  ollamaUrl: string,
  model: string,
  timeoutMs = 300_000
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${ollamaUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Wait for Ollama to become reachable. */
async function waitForOllama(
  ollamaUrl: string,
  maxAttempts = 20,
  delayMs = 3000
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

/** Run the full Ollama enable sequence in the background. */
async function runOllamaEnableBackground(requestId: string): Promise<void> {
  const state = getState();
  const ollamaUrl = "http://ollama:11434";
  const task = ollamaTask!;

  try {
    // 1. Enable Ollama in stack.env
    task.phase = "starting";
    task.message = "Configuring Ollama in compose stack...";
    logger.info("enabling Ollama in stack.env", { requestId });

    ensureXdgDirs();
    const dataStackEnv = `${state.dataDir}/stack.env`;
    mkdirSync(state.dataDir, { recursive: true });
    const base = existsSync(dataStackEnv)
      ? readFileSync(dataStackEnv, "utf-8")
      : "";
    const updated = mergeEnvContent(base, {
      OPENPALM_OLLAMA_ENABLED: "true",
    });
    writeFileSync(dataStackEnv, updated);

    // 2. Ensure the Ollama compose overlay is in DATA_HOME
    ensureOllamaCompose();

    // 3. Re-stage artifacts so the overlay is included
    state.artifacts = stageArtifacts(state);
    persistArtifacts(state);

    // 4. Start Ollama via compose
    logger.info("starting Ollama via compose", { requestId });
    const composeFiles = buildComposeFileList(state);
    const envFiles = buildEnvFiles(state);

    const composeResult = await composeUp(state.stateDir, {
      files: composeFiles,
      envFiles,
      services: ["ollama"],
      forceRecreate: true,
    });

    if (!composeResult.ok) {
      task.phase = "error";
      task.message = `Failed to start Ollama: ${composeResult.stderr}`;
      logger.error("compose failed for Ollama", { requestId, stderr: composeResult.stderr });
      return;
    }

    // 5. Wait for Ollama to become healthy
    task.phase = "waiting";
    task.message = "Waiting for Ollama to become healthy...";
    logger.info("waiting for Ollama to become healthy", { requestId });

    const healthy = await waitForOllama(ollamaUrl);
    if (!healthy) {
      task.phase = "error";
      task.message = "Ollama started but did not become healthy in time.";
      logger.error("Ollama health check timed out", { requestId });
      return;
    }

    // 6. Pull default models
    task.phase = "pulling";
    task.message = `Pulling default models (${OLLAMA_DEFAULT_MODELS.chat}, ${OLLAMA_DEFAULT_MODELS.embedding})...`;
    task.ollamaUrl = ollamaUrl;

    logger.info("pulling default Ollama chat model", { model: OLLAMA_DEFAULT_MODELS.chat });
    task.models[OLLAMA_DEFAULT_MODELS.chat] = await pullOllamaModel(
      ollamaUrl,
      OLLAMA_DEFAULT_MODELS.chat
    );

    logger.info("pulling default Ollama embedding model", { model: OLLAMA_DEFAULT_MODELS.embedding });
    task.models[OLLAMA_DEFAULT_MODELS.embedding] = await pullOllamaModel(
      ollamaUrl,
      OLLAMA_DEFAULT_MODELS.embedding
    );

    task.allModelsPulled = Object.values(task.models).every((r) => r.ok);
    task.defaultChatModel = OLLAMA_DEFAULT_MODELS.chat;
    task.defaultEmbeddingModel = OLLAMA_DEFAULT_MODELS.embedding;
    task.phase = "done";
    task.message = "Ollama enabled and models pulled.";
    logger.info("Ollama background enable completed", { requestId, allPulled: task.allModelsPulled });
  } catch (err) {
    task.phase = "error";
    task.message = err instanceof Error ? err.message : String(err);
    logger.error("Ollama background enable failed", { requestId, error: task.message });
  } finally {
    ollamaTaskRunning = false;
  }
}


/**
 * GET /admin/setup/ollama — Poll background task status.
 */
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdminOrSetupToken(event, requestId);
  if (authError) return authError;

  if (!ollamaTask) {
    return jsonResponse(200, { active: false }, requestId);
  }

  const isTerminal = ollamaTask.phase === "done" || ollamaTask.phase === "error";

  const response = jsonResponse(
    200,
    {
      active: !isTerminal,
      phase: ollamaTask.phase,
      message: ollamaTask.message,
      ollamaUrl: ollamaTask.ollamaUrl,
      models: ollamaTask.models,
      allModelsPulled: ollamaTask.allModelsPulled,
      defaultChatModel: ollamaTask.defaultChatModel,
      defaultEmbeddingModel: ollamaTask.defaultEmbeddingModel,
    },
    requestId
  );

  // Clear stale state after the client has consumed the terminal result
  if (isTerminal) {
    clearOllamaTask();
  }

  return response;
};

/**
 * POST /admin/setup/ollama — Kick off async Ollama enable.
 *
 * Returns immediately with { ok: true, async: true }. The UI should
 * poll GET /admin/setup/ollama for progress.
 */
export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("ollama enable request received", { requestId });

  const authError = requireAdminOrSetupToken(event, requestId);
  if (authError) return authError;

  if (ollamaTaskRunning) {
    return jsonResponse(409, { error: 'ollama_task_in_progress', message: 'An Ollama setup task is already running' }, requestId);
  }

  // If a task is already running, return its current status
  if (ollamaTask && (ollamaTask.phase === "starting" || ollamaTask.phase === "waiting" || ollamaTask.phase === "pulling")) {
    return jsonResponse(200, {
      ok: true,
      async: true,
      phase: ollamaTask.phase,
      message: ollamaTask.message,
    }, requestId);
  }

  // Check Docker availability synchronously before starting background work
  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    return errorResponse(
      503,
      "docker_unavailable",
      "Docker is not available. Install or start Docker and retry.",
      { stderr: dockerCheck.stderr },
      requestId
    );
  }

  // Initialize task state and start background work
  ollamaTask = {
    phase: "starting",
    message: "Configuring Ollama in compose stack...",
    ollamaUrl: "http://ollama:11434",
    models: {},
    allModelsPulled: false,
    defaultChatModel: OLLAMA_DEFAULT_MODELS.chat,
    defaultEmbeddingModel: OLLAMA_DEFAULT_MODELS.embedding,
  };

  // Fire and forget — runs in background
  ollamaTaskRunning = true;
  void runOllamaEnableBackground(requestId);

  return jsonResponse(
    200,
    {
      ok: true,
      async: true,
      phase: "starting",
      message: "Ollama enable started in background. Poll GET /admin/setup/ollama for status.",
    },
    requestId
  );
};
