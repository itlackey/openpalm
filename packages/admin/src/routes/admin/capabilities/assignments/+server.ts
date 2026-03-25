/**
 * GET  /admin/capabilities/assignments — Return current capabilities from stack.yml.
 * POST /admin/capabilities/assignments — Update capabilities in stack.yml.
 */
import type { RequestHandler } from './$types';
import type {
  StackSpecEmbeddings,
  StackSpecMemory,
  StackSpecReranker,
  StackSpecStt,
  StackSpecTts,
} from '@openpalm/lib';
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

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, label: string): ParseResult<string> {
  if (typeof v !== 'string' || !v.trim()) return { ok: false, message: `${label} must be a non-empty string` };
  return { ok: true, value: v.trim() };
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, label: string): string | null {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) return `${label} contains unsupported key "${k}"`;
  }
  return null;
}

function parseCapabilityRef(value: unknown, key: string): ParseResult<string> {
  const r = requireString(value, key);
  if (!r.ok) return { ok: false, message: `${key} must be a non-empty "provider/model" string` };
  const idx = r.value.indexOf('/');
  if (idx <= 0 || idx === r.value.length - 1) return { ok: false, message: `${key} must use "provider/model" format` };
  return r;
}

/** Parse an object with known string fields, optional boolean `enabled`, and reject unknown keys. */
function parseObjectCapability<T>(
  value: unknown,
  label: string,
  allowedKeys: Set<string>,
  stringKeys: readonly string[],
  extraValidate?: (obj: Record<string, unknown>, result: Record<string, unknown>) => string | null,
): ParseResult<Partial<T>> {
  if (!isRecord(value)) return { ok: false, message: `${label} must be an object` };
  const bad = rejectUnknownKeys(value, allowedKeys, label);
  if (bad) return { ok: false, message: bad };

  const result: Record<string, unknown> = {};
  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') return { ok: false, message: `${label}.enabled must be a boolean` };
    result.enabled = value.enabled;
  }
  for (const k of stringKeys) {
    if (k in value) {
      if (typeof value[k] !== 'string') return { ok: false, message: `${label}.${k} must be a string` };
      result[k] = value[k];
    }
  }
  const extraErr = extraValidate?.(value, result);
  if (extraErr) return { ok: false, message: extraErr };
  return { ok: true, value: result as Partial<T> };
}

function parseEmbeddings(value: unknown): ParseResult<Partial<StackSpecEmbeddings>> {
  return parseObjectCapability<StackSpecEmbeddings>(value, 'embeddings', new Set(['provider', 'model', 'dims']), ['provider', 'model'], (obj, result) => {
    if ('dims' in obj) {
      if (typeof obj.dims !== 'number' || !Number.isInteger(obj.dims) || obj.dims <= 0) {
        return 'embeddings.dims must be a positive integer';
      }
      result.dims = obj.dims;
    }
    return null;
  });
}

function parseMemory(value: unknown): ParseResult<Partial<StackSpecMemory>> {
  return parseObjectCapability<StackSpecMemory>(value, 'memory', new Set(['userId', 'customInstructions']), ['customInstructions'], (obj, result) => {
    if ('userId' in obj) {
      if (typeof obj.userId !== 'string') return 'memory.userId must be a string';
      if (!/^[a-zA-Z0-9_]+$/.test(obj.userId)) return 'memory.userId must contain only alphanumeric characters and underscores';
      result.userId = obj.userId;
    }
    return null;
  });
}

function parseReranking(value: unknown): ParseResult<Partial<StackSpecReranker>> {
  return parseObjectCapability<StackSpecReranker>(value, 'reranking', new Set(['enabled', 'provider', 'mode', 'model', 'topK', 'topN']), ['provider', 'model'], (obj, result) => {
    if ('mode' in obj) {
      if (obj.mode !== 'llm' && obj.mode !== 'dedicated') return 'reranking.mode must be "llm" or "dedicated"';
      result.mode = obj.mode;
    }
    for (const k of ['topK', 'topN'] as const) {
      if (k in obj) {
        if (typeof obj[k] !== 'number' || !Number.isInteger(obj[k]) || (obj[k] as number) <= 0) return `reranking.${k} must be a positive integer`;
        result[k] = obj[k];
      }
    }
    return null;
  });
}

/** Apply an optional capability that supports `undefined` (delete) or merge. */
function applyOptionalCapability<T>(
  capabilities: Record<string, unknown>,
  spec: { capabilities: Record<string, unknown> },
  key: string,
  parser: (v: unknown) => ParseResult<Partial<T>>,
  requestId: string,
  requireEnabled = false,
): Response | null {
  if (!(key in capabilities)) return null;
  if (capabilities[key] === undefined) {
    delete spec.capabilities[key];
    return null;
  }
  const parsed = parser(capabilities[key]);
  if (!parsed.ok) return errorResponse(400, 'bad_request', parsed.message, {}, requestId);

  const merged = { ...spec.capabilities[key] as Record<string, unknown>, ...parsed.value };
  if (requireEnabled && typeof merged.enabled !== 'boolean') {
    return errorResponse(400, 'bad_request', `${key}.enabled must be a boolean`, {}, requestId);
  }
  spec.capabilities[key] = merged;
  return null;
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

  const capabilities = raw;
  const unknownKey = rejectUnknownKeys(capabilities, TOP_LEVEL_KEYS, 'capabilities');
  if (unknownKey) return errorResponse(400, 'bad_request', unknownKey, {}, requestId);

  const spec = readStackSpec(state.configDir);
  if (!spec) return errorResponse(500, 'internal_error', 'stack.yml not found', {}, requestId);

  // LLM (required string, never deletable)
  if ('llm' in capabilities) {
    const parsed = parseCapabilityRef(capabilities.llm, 'llm');
    if (!parsed.ok) return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
    spec.capabilities.llm = parsed.value;
  }

  // SLM (optional string, deletable)
  if ('slm' in capabilities) {
    if (capabilities.slm === undefined) { delete spec.capabilities.slm; }
    else {
      const parsed = parseCapabilityRef(capabilities.slm, 'slm');
      if (!parsed.ok) return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
      spec.capabilities.slm = parsed.value;
    }
  }

  // Object capabilities (merge-style)
  if ('embeddings' in capabilities) {
    const parsed = parseEmbeddings(capabilities.embeddings);
    if (!parsed.ok) return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
    spec.capabilities.embeddings = { ...spec.capabilities.embeddings, ...parsed.value };
  }

  if ('memory' in capabilities) {
    const parsed = parseMemory(capabilities.memory);
    if (!parsed.ok) return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
    spec.capabilities.memory = { ...spec.capabilities.memory, ...parsed.value };
  }

  // Optional capabilities with required `enabled` boolean
  let err: Response | null;
  err = applyOptionalCapability<StackSpecTts>(capabilities, spec, 'tts',
    (v) => parseObjectCapability<StackSpecTts>(v, 'tts', new Set(['enabled', 'provider', 'model', 'voice', 'format']), ['provider', 'model', 'voice', 'format']),
    requestId, true);
  if (err) return err;

  err = applyOptionalCapability<StackSpecStt>(capabilities, spec, 'stt',
    (v) => parseObjectCapability<StackSpecStt>(v, 'stt', new Set(['enabled', 'provider', 'model', 'language']), ['provider', 'model', 'language']),
    requestId, true);
  if (err) return err;

  err = applyOptionalCapability<StackSpecReranker>(capabilities, spec, 'reranking', parseReranking, requestId, true);
  if (err) return err;

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
