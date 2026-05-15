/**
 * GET  /admin/capabilities — Return current capabilities and masked secrets.
 * POST /admin/capabilities — Update capabilities in stack.yml and/or secrets in stack.env.
 */
import type { RequestHandler } from "./$types";
import { mkdirSync, writeFileSync } from "node:fs";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType,
  parseJsonBody,
  jsonBodyError,
} from "$lib/server/helpers.js";
import {
  appendAudit,
  readStackEnv,
  patchSecretsEnvFile,
  readStackSpec,
  writeStackSpec,
  writeCapabilityVars,
  buildAkmSetupJson,
  formatCapabilityString,
  maskSecretValue,
  createLogger,
} from "@openpalm/lib";
import {
  PROVIDER_KEY_MAP,
  EMBEDDING_DIMS,
} from "@openpalm/lib/provider-constants";

const logger = createLogger("capabilities");

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // Read secrets (masked)
  const raw = readStackEnv(state.stateDir);
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    secrets[key] = maskSecretValue(key, value);
  }

  // Read capabilities from stack.yml
  const spec = readStackSpec(state.configDir);
  const capabilities = spec?.capabilities ?? null;

  appendAudit(state, actor, "capabilities.get", {}, true, requestId, callerType);
  return jsonResponse(200, {
    capabilities,
    secrets,
  }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data;

  // ── Capabilities + secrets save ─────────────────────────────────────
  const provider = typeof body.provider === "string" ? body.provider : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  const systemModel = typeof body.systemModel === "string" ? body.systemModel : "";
  const embeddingModel = typeof body.embeddingModel === "string" ? body.embeddingModel : "";
  const embeddingDims = typeof body.embeddingDims === "number" ? body.embeddingDims : 0;

  if (!provider) {
    return errorResponse(400, "bad_request", "provider is required", {}, requestId);
  }

  // 1. Write API key to stack.env (secrets only)
  const secretPatches: Record<string, string> = {};
  if (apiKey) {
    const envVarName = PROVIDER_KEY_MAP[provider] ?? "OPENAI_API_KEY";
    secretPatches[envVarName] = apiKey;
  }
  if (Object.keys(secretPatches).length > 0) {
    try {
      patchSecretsEnvFile(state.stateDir, secretPatches);
    } catch (err) {
      appendAudit(state, actor, "capabilities.save", { provider, error: String(err) }, false, requestId, callerType);
      return errorResponse(500, "internal_error", "Failed to update state/stack.env", {}, requestId);
    }
  }

  // 2. Update stack.yml capabilities
  const lookupKey = `${provider}/${embeddingModel}`;
  const resolvedDims = embeddingDims || EMBEDDING_DIMS[lookupKey] || 1536;

  try {
    const spec = readStackSpec(state.configDir);
    if (!spec) throw new Error('stack.yml not found or invalid');
    spec.capabilities.llm = formatCapabilityString(provider, systemModel);
    spec.capabilities.embeddings = {
      provider,
      model: embeddingModel || "text-embedding-3-small",
      dims: resolvedDims,
    };
    writeStackSpec(state.configDir, spec);
    writeCapabilityVars(spec, state.stateDir);
    const akmJson = buildAkmSetupJson(spec, readStackEnv(state.stateDir));
    if (akmJson) {
      const akmConfigDir = `${state.stateDir}/akm/config`;
      mkdirSync(akmConfigDir, { recursive: true });
      writeFileSync(`${akmConfigDir}/config.json`, akmJson, { mode: 0o600 });
    }
  } catch (err) {
    appendAudit(state, actor, "capabilities.save", { provider, error: String(err) }, false, requestId, callerType);
    return errorResponse(500, "internal_error", "Failed to update stack.yml", {}, requestId);
  }

  appendAudit(state, actor, "capabilities.save", { provider }, true, requestId, callerType);
  logger.info("capabilities save", { provider, requestId });

  return jsonResponse(200, {
    ok: true,
  }, requestId);
};
