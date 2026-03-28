/**
 * GET  /admin/capabilities/assignments — Return current capabilities from stack.yml.
 * POST /admin/capabilities/assignments — Update capabilities in stack.yml.
 */
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  appendAudit,
  readStackSpec,
  writeStackSpec,
  writeCapabilityVars,
} from '@openpalm/lib';
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

const TOP_LEVEL_KEYS = new Set(['llm', 'slm', 'embeddings', 'memory', 'tts', 'stt', 'reranking']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireCapRef(value: unknown, key: string, requestId: string): string | Response {
  if (typeof value !== 'string' || !value.trim()) return errorResponse(400, 'bad_request', `${key} must be a non-empty "provider/model" string`, {}, requestId);
  const idx = value.indexOf('/');
  if (idx <= 0 || idx === value.length - 1) return errorResponse(400, 'bad_request', `${key} must use "provider/model" format`, {}, requestId);
  return value.trim();
}

/** Merge an object capability, picking only known string/number/boolean fields. */
function mergeCapability(
  existing: Record<string, unknown> | undefined,
  input: unknown,
  label: string,
  schema: Record<string, 'string' | 'number' | 'boolean'>,
  requestId: string,
): Record<string, unknown> | Response {
  if (!isRecord(input)) return errorResponse(400, 'bad_request', `${label} must be an object`, {}, requestId);
  const result: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(input)) {
    const expected = schema[k];
    if (!expected) return errorResponse(400, 'bad_request', `${label} contains unsupported key "${k}"`, {}, requestId);
    if (expected === 'number') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
        return errorResponse(400, 'bad_request', `${label}.${k} must be a positive integer`, {}, requestId);
      }
    } else if (typeof v !== expected) {
      return errorResponse(400, 'bad_request', `${label}.${k} must be a ${expected}`, {}, requestId);
    }
    result[k] = v;
  }
  return result;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const spec = readStackSpec(state.configDir);
  appendAudit(state, getActor(event), 'capabilities.assignments.get', {}, true, requestId, getCallerType(event));
  return jsonResponse(200, { capabilities: spec?.capabilities ?? null }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data;

  const raw = body.capabilities ?? body;
  if (!isRecord(raw)) return errorResponse(400, 'bad_request', 'capabilities must be an object', {}, requestId);

  for (const k of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(k)) return errorResponse(400, 'bad_request', `capabilities contains unsupported key "${k}"`, {}, requestId);
  }

  const spec = readStackSpec(state.configDir);
  if (!spec) return errorResponse(500, 'internal_error', 'stack.yml not found', {}, requestId);

  // LLM (required string, never deletable)
  if ('llm' in raw) {
    const r = requireCapRef(raw.llm, 'llm', requestId);
    if (r instanceof Response) return r;
    spec.capabilities.llm = r;
  }

  // SLM (optional string, deletable)
  if ('slm' in raw) {
    if (raw.slm === undefined) { delete spec.capabilities.slm; }
    else {
      const r = requireCapRef(raw.slm, 'slm', requestId);
      if (r instanceof Response) return r;
      spec.capabilities.slm = r;
    }
  }

  // Embeddings
  if ('embeddings' in raw) {
    const r = mergeCapability(spec.capabilities.embeddings as Record<string, unknown>, raw.embeddings, 'embeddings',
      { provider: 'string', model: 'string', dims: 'number' }, requestId);
    if (r instanceof Response) return r;
    spec.capabilities.embeddings = r as typeof spec.capabilities.embeddings;
  }

  // Memory
  if ('memory' in raw) {
    const r = mergeCapability(spec.capabilities.memory as Record<string, unknown>, raw.memory, 'memory',
      { userId: 'string', customInstructions: 'string' }, requestId);
    if (r instanceof Response) return r;
    spec.capabilities.memory = r as typeof spec.capabilities.memory;
  }

  // TTS, STT, Reranking — optional, deletable
  const optionalSchemas: Record<string, Record<string, 'string' | 'number' | 'boolean'>> = {
    tts: { enabled: 'boolean', provider: 'string', model: 'string', voice: 'string', format: 'string' },
    stt: { enabled: 'boolean', provider: 'string', model: 'string', language: 'string' },
    reranking: { enabled: 'boolean', provider: 'string', mode: 'string', model: 'string', topK: 'number', topN: 'number' },
  };
  for (const [key, schema] of Object.entries(optionalSchemas)) {
    if (!(key in raw)) continue;
    if (raw[key] === undefined) { delete (spec.capabilities as Record<string, unknown>)[key]; continue; }
    const r = mergeCapability((spec.capabilities as Record<string, unknown>)[key] as Record<string, unknown>, raw[key], key, schema, requestId);
    if (r instanceof Response) return r;
    (spec.capabilities as Record<string, unknown>)[key] = r;
  }

  try {
    writeStackSpec(state.configDir, spec);
    writeCapabilityVars(spec, state.vaultDir);
  } catch (e) {
    appendAudit(state, actor, 'capabilities.assignments.save', { error: String(e) }, false, requestId, callerType);
    return errorResponse(500, 'internal_error', 'Failed to persist capabilities', {}, requestId);
  }

  appendAudit(state, actor, 'capabilities.assignments.save', {}, true, requestId, callerType);
  return jsonResponse(200, { ok: true, capabilities: spec.capabilities }, requestId);
};
