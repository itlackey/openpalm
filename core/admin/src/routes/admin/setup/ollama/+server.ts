/**
 * POST /admin/setup/ollama — Enable Ollama in the compose stack.
 *
 * 1. Stages the ollama.yml overlay
 * 2. Sets OPENPALM_OLLAMA_ENABLED=true in stack.env
 * 3. Runs docker compose up for the ollama service
 * 4. Waits for Ollama to become healthy
 * 5. Pulls default models (qwen3:0.6b + nomic-embed-text)
 *
 * Auth: setup token during wizard, admin token after setup.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  getRequestId,
  safeTokenCompare
} from "$lib/server/helpers.js";
import { isSetupComplete } from "$lib/server/setup-status.js";
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

/** Pull a model from Ollama via its HTTP API, with retries. */
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

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const state = getState();
  const setupComplete = isSetupComplete(state.stateDir, state.configDir);

  // Auth: accept either setup token (first-run) or admin token (post-setup)
  const token = event.request.headers.get("x-admin-token") ?? "";
  const validSetupToken =
    !setupComplete && safeTokenCompare(token, state.setupToken);
  const validAdminToken =
    setupComplete && safeTokenCompare(token, state.adminToken);
  if (!validSetupToken && !validAdminToken) {
    return errorResponse(
      401,
      "unauthorized",
      "Missing or invalid token",
      {},
      requestId
    );
  }

  // Check Docker availability
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

  // 1. Enable Ollama in stack.env
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
  const composeFiles = buildComposeFileList(state);
  const envFiles = buildEnvFiles(state);

  const composeResult = await composeUp(state.stateDir, {
    files: composeFiles,
    envFiles,
    services: ["ollama"],
    forceRecreate: true,
  });

  if (!composeResult.ok) {
    return errorResponse(
      502,
      "compose_failed",
      `Failed to start Ollama: ${composeResult.stderr}`,
      { stderr: composeResult.stderr },
      requestId
    );
  }

  // 5. Wait for Ollama to become healthy
  // Use the in-stack URL (Docker network name)
  const ollamaUrl = "http://ollama:11434";
  const healthy = await waitForOllama(ollamaUrl);
  if (!healthy) {
    return errorResponse(
      504,
      "ollama_timeout",
      "Ollama started but did not become healthy in time.",
      {},
      requestId
    );
  }

  // 6. Pull default models
  const pullResults: Record<string, { ok: boolean; error?: string }> = {};

  logger.info("pulling default Ollama chat model", {
    model: OLLAMA_DEFAULT_MODELS.chat,
  });
  pullResults[OLLAMA_DEFAULT_MODELS.chat] = await pullOllamaModel(
    ollamaUrl,
    OLLAMA_DEFAULT_MODELS.chat
  );

  logger.info("pulling default Ollama embedding model", {
    model: OLLAMA_DEFAULT_MODELS.embedding,
  });
  pullResults[OLLAMA_DEFAULT_MODELS.embedding] = await pullOllamaModel(
    ollamaUrl,
    OLLAMA_DEFAULT_MODELS.embedding
  );

  const allPulled = Object.values(pullResults).every((r) => r.ok);

  return jsonResponse(
    200,
    {
      ok: true,
      ollamaEnabled: true,
      ollamaUrl,
      models: pullResults,
      allModelsPulled: allPulled,
      defaultChatModel: OLLAMA_DEFAULT_MODELS.chat,
      defaultEmbeddingModel: OLLAMA_DEFAULT_MODELS.embedding,
    },
    requestId
  );
};
