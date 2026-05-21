/**
 * GET  /admin/akm  — Return current akm config from OP_HOME/config/akm/config.json
 * PATCH /admin/akm — Update config fields (connections, features, behavior, tuning)
 */
import type { RequestHandler } from './$types';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { getState } from '$lib/server/state.js';
import { appendAudit } from '@openpalm/lib';
import {
  errorResponse,
  getActor,
  getCallerType,
  getRequestId,
  jsonResponse,
  parseJsonBody,
  jsonBodyError,
  requireAdmin,
} from '$lib/server/helpers.js';

function akmConfigPath(configDir: string): string {
  return `${configDir}/akm/config.json`;
}

function readAkmConfig(configDir: string): Record<string, unknown> {
  const path = akmConfigPath(configDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const config = readAkmConfig(state.configDir);
  return jsonResponse(200, { config }, requestId);
};

const SEMANTIC_SEARCH_MODES = new Set(['auto', 'off']);
const OUTPUT_FORMATS = new Set(['json', 'yaml', 'text']);
const IMPROVE_PRESETS = new Set(['fast', 'thorough', 'mixed', 'custom']);
const STASH_INHERITANCE = new Set(['merge', 'replace']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const PATCH: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data as Record<string, unknown>;

  // ── Validate llm connection ───────────────────────────────────────────────
  const llmBody = body.llm as Record<string, unknown> | undefined;
  if (llmBody !== undefined) {
    if (!isRecord(llmBody)) return errorResponse(400, 'bad_request', 'llm must be an object', {}, requestId);
    if ('endpoint' in llmBody && typeof llmBody.endpoint !== 'string')
      return errorResponse(400, 'bad_request', 'llm.endpoint must be a string', {}, requestId);
    if ('model' in llmBody && typeof llmBody.model !== 'string')
      return errorResponse(400, 'bad_request', 'llm.model must be a string', {}, requestId);
    if ('provider' in llmBody && typeof llmBody.provider !== 'string')
      return errorResponse(400, 'bad_request', 'llm.provider must be a string', {}, requestId);
    if ('apiKey' in llmBody && typeof llmBody.apiKey !== 'string')
      return errorResponse(400, 'bad_request', 'llm.apiKey must be a string', {}, requestId);
    if ('features' in llmBody) {
      if (!isRecord(llmBody.features)) return errorResponse(400, 'bad_request', 'llm.features must be an object', {}, requestId);
      for (const k of ['feedback_distillation', 'memory_inference', 'memory_consolidation'] as const) {
        if (k in llmBody.features && typeof (llmBody.features as Record<string, unknown>)[k] !== 'boolean')
          return errorResponse(400, 'bad_request', `llm.features.${k} must be a boolean`, {}, requestId);
      }
    }
  }

  // ── Validate embedding connection ─────────────────────────────────────────
  const embBody = body.embedding as Record<string, unknown> | undefined;
  if (embBody !== undefined) {
    if (!isRecord(embBody)) return errorResponse(400, 'bad_request', 'embedding must be an object', {}, requestId);
    if ('endpoint' in embBody && typeof embBody.endpoint !== 'string')
      return errorResponse(400, 'bad_request', 'embedding.endpoint must be a string', {}, requestId);
    if ('model' in embBody && typeof embBody.model !== 'string')
      return errorResponse(400, 'bad_request', 'embedding.model must be a string', {}, requestId);
    if ('provider' in embBody && typeof embBody.provider !== 'string')
      return errorResponse(400, 'bad_request', 'embedding.provider must be a string', {}, requestId);
    if ('dimension' in embBody) {
      const v = embBody.dimension;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
        return errorResponse(400, 'bad_request', 'embedding.dimension must be a positive integer', {}, requestId);
    }
  }

  // ── Validate scalar fields ────────────────────────────────────────────────
  if ('semanticSearchMode' in body && (typeof body.semanticSearchMode !== 'string' || !SEMANTIC_SEARCH_MODES.has(body.semanticSearchMode as string)))
    return errorResponse(400, 'bad_request', 'semanticSearchMode must be "auto" or "off"', {}, requestId);

  if ('archiveRetentionDays' in body) {
    const v = body.archiveRetentionDays;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 365)
      return errorResponse(400, 'bad_request', 'archiveRetentionDays must be an integer 1–365', {}, requestId);
  }

  if ('stashInheritance' in body && (typeof body.stashInheritance !== 'string' || !STASH_INHERITANCE.has(body.stashInheritance as string)))
    return errorResponse(400, 'bad_request', 'stashInheritance must be "merge" or "replace"', {}, requestId);

  const outputBody = body.output as Record<string, unknown> | undefined;
  if (outputBody !== undefined) {
    if (!isRecord(outputBody)) return errorResponse(400, 'bad_request', 'output must be an object', {}, requestId);
    if ('format' in outputBody && (typeof outputBody.format !== 'string' || !OUTPUT_FORMATS.has(outputBody.format as string)))
      return errorResponse(400, 'bad_request', 'output.format must be "json", "yaml", or "text"', {}, requestId);
  }

  const defaultsBody = body.defaults as Record<string, unknown> | undefined;
  if (defaultsBody !== undefined) {
    if (!isRecord(defaultsBody)) return errorResponse(400, 'bad_request', 'defaults must be an object', {}, requestId);
    const improveBody = defaultsBody.improve as Record<string, unknown> | undefined;
    if (improveBody !== undefined) {
      if (!isRecord(improveBody)) return errorResponse(400, 'bad_request', 'defaults.improve must be an object', {}, requestId);
      if ('limit' in improveBody) {
        const v = improveBody.limit;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100)
          return errorResponse(400, 'bad_request', 'defaults.improve.limit must be an integer 1–100', {}, requestId);
      }
      if ('preset' in improveBody && (typeof improveBody.preset !== 'string' || !IMPROVE_PRESETS.has(improveBody.preset as string)))
        return errorResponse(400, 'bad_request', 'defaults.improve.preset must be "fast", "thorough", "mixed", or "custom"', {}, requestId);
    }
  }

  const searchBody = body.search as Record<string, unknown> | undefined;
  if (searchBody !== undefined) {
    if (!isRecord(searchBody)) return errorResponse(400, 'bad_request', 'search must be an object', {}, requestId);
    if ('minScore' in searchBody) {
      const v = searchBody.minScore;
      if (typeof v !== 'number' || v < 0 || v > 1)
        return errorResponse(400, 'bad_request', 'search.minScore must be a number between 0 and 1', {}, requestId);
    }
  }

  // ── Merge and write ───────────────────────────────────────────────────────
  try {
    const existing = readAkmConfig(state.configDir);
    const updated: Record<string, unknown> = { ...existing };

    // LLM connection — pick only known fields
    if (llmBody !== undefined) {
      const existingLlm = (existing.llm as Record<string, unknown>) ?? {};
      const existingFeatures = (existingLlm.features as Record<string, unknown>) ?? {};
      const incomingFeatures = llmBody.features as Record<string, unknown> | undefined;
      const mergedFeatures = incomingFeatures !== undefined
        ? {
            ...existingFeatures,
            ...('feedback_distillation' in incomingFeatures ? { feedback_distillation: incomingFeatures.feedback_distillation } : {}),
            ...('memory_inference' in incomingFeatures ? { memory_inference: incomingFeatures.memory_inference } : {}),
            ...('memory_consolidation' in incomingFeatures ? { memory_consolidation: incomingFeatures.memory_consolidation } : {}),
          }
        : existingFeatures;
      const mergedLlm: Record<string, unknown> = {
        ...existingLlm,
        ...('endpoint' in llmBody ? { endpoint: llmBody.endpoint } : {}),
        ...('model' in llmBody ? { model: llmBody.model } : {}),
        ...('provider' in llmBody ? { provider: llmBody.provider } : {}),
        features: mergedFeatures,
      };
      // apiKey: only write if non-empty; omit if cleared
      if ('apiKey' in llmBody) {
        if (llmBody.apiKey) mergedLlm.apiKey = llmBody.apiKey;
        else delete mergedLlm.apiKey;
      }
      updated.llm = mergedLlm;
    }

    // Embedding connection — pick only known fields
    if (embBody !== undefined) {
      const existingEmb = (existing.embedding as Record<string, unknown>) ?? {};
      const mergedEmb: Record<string, unknown> = {
        ...existingEmb,
        ...('endpoint' in embBody ? { endpoint: embBody.endpoint } : {}),
        ...('model' in embBody ? { model: embBody.model } : {}),
        ...('provider' in embBody ? { provider: embBody.provider } : {}),
        ...('dimension' in embBody ? { dimension: embBody.dimension } : {}),
      };
      updated.embedding = mergedEmb;
    }

    // Scalar fields
    if ('semanticSearchMode' in body) updated.semanticSearchMode = body.semanticSearchMode;
    if ('archiveRetentionDays' in body) updated.archiveRetentionDays = body.archiveRetentionDays;
    if ('stashInheritance' in body) updated.stashInheritance = body.stashInheritance;

    // Nested — pick only known sub-keys
    if (outputBody !== undefined) {
      const existingOutput = (existing.output as Record<string, unknown>) ?? {};
      updated.output = { ...existingOutput, ...('format' in outputBody ? { format: outputBody.format } : {}) };
    }

    if (defaultsBody !== undefined) {
      const existingDefaults = (existing.defaults as Record<string, unknown>) ?? {};
      const existingImprove = (existingDefaults.improve as Record<string, unknown>) ?? {};
      const improveBody = defaultsBody.improve as Record<string, unknown> | undefined;
      const mergedImprove = improveBody !== undefined
        ? {
            ...existingImprove,
            ...('limit' in improveBody ? { limit: improveBody.limit } : {}),
            ...('preset' in improveBody ? { preset: improveBody.preset } : {}),
          }
        : existingImprove;
      updated.defaults = { ...existingDefaults, improve: mergedImprove };
    }

    if (searchBody !== undefined) {
      const existingSearch = (existing.search as Record<string, unknown>) ?? {};
      updated.search = { ...existingSearch, ...('minScore' in searchBody ? { minScore: searchBody.minScore } : {}) };
    }

    mkdirSync(`${state.configDir}/akm`, { recursive: true });
    writeFileSync(akmConfigPath(state.configDir), JSON.stringify(updated, null, 2), { mode: 0o600 });

    appendAudit(state, actor, 'akm.config.save', {}, true, requestId, callerType);
    return jsonResponse(200, { ok: true, config: updated }, requestId);
  } catch (e) {
    appendAudit(state, actor, 'akm.config.save', { error: String(e) }, false, requestId, callerType);
    return errorResponse(500, 'internal_error', 'Failed to persist akm config', {}, requestId);
  }
};
