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
import { PROVIDER_KEY_MAP, NO_KEY_PROVIDERS } from "$lib/provider-constants.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const raw = readSecretsEnvFile(state.configDir);
  const missing: string[] = [];

  const provider = (raw.SYSTEM_LLM_PROVIDER ?? raw.GUARDIAN_LLM_PROVIDER ?? "").trim();
  const systemModel = (raw.SYSTEM_LLM_MODEL ?? raw.GUARDIAN_LLM_MODEL ?? "").trim();
  const baseUrl = (raw.SYSTEM_LLM_BASE_URL ?? "").trim();

  if (!provider) {
    missing.push("System LLM provider");
  } else if (!NO_KEY_PROVIDERS.has(provider)) {
    // Provider needs an API key — check it (custom baseUrl counts as "no key needed")
    if (!baseUrl) {
      const keyVar = PROVIDER_KEY_MAP[provider];
      if (keyVar && !(raw[keyVar] ?? "").trim()) {
        missing.push(`${provider} API key`);
      }
    }
  }

  if (!systemModel) {
    missing.push("System model");
  }

  const complete = missing.length === 0;

  appendAudit(
    state, actor, "connections.status",
    { complete, missing },
    true, requestId, callerType
  );

  return jsonResponse(200, { complete, missing }, requestId);
};
