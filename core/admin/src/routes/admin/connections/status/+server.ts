/**
 * GET /admin/connections/status — Check if the system LLM connection is configured.
 *
 * Returns { complete: boolean, missing: string[] }.
 * "complete" is true when a system provider is selected and its API key is set
 * (or the provider doesn't need a key, like ollama/lmstudio).
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import {
  appendAudit,
  readSecretsEnvFile
} from "$lib/server/control-plane.js";

/** Map provider → env var for API key. */
const PROVIDER_KEY_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  google: "GOOGLE_API_KEY",
};

const NO_KEY_PROVIDERS = new Set(["ollama", "lmstudio"]);

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const raw = readSecretsEnvFile(state.configDir);
  const missing: string[] = [];

  const provider = (raw.SYSTEM_LLM_PROVIDER ?? "").trim();

  if (!provider) {
    // No system provider configured yet
    missing.push("System LLM provider");
  } else if (!NO_KEY_PROVIDERS.has(provider)) {
    // Provider needs an API key — check it
    const keyVar = PROVIDER_KEY_MAP[provider];
    if (keyVar && !(raw[keyVar] ?? "").trim()) {
      missing.push(`${provider} API key`);
    }
  }

  if (!(raw.GUARDIAN_LLM_MODEL ?? "").trim()) {
    missing.push("Guardian model");
  }

  const complete = missing.length === 0;

  appendAudit(
    state, actor, "connections.status",
    { complete, missing },
    true, requestId, callerType
  );

  return jsonResponse(200, { complete, missing }, requestId);
};
