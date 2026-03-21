/**
 * GET  /admin/connections/assignments — Return current capabilities from stack.yaml.
 * POST /admin/connections/assignments — Update capabilities in stack.yaml.
 */
import type { RequestHandler } from './$types';
import type {
  StackSpecCapabilities,
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
  writeManagedEnvFiles,
} from '$lib/server/control-plane.js';
import {
  errorResponse,
  getActor,
  getCallerType,
  getRequestId,
  jsonResponse,
  parseJsonBody,
  requireAdmin,
} from '$lib/server/helpers.js';

const TOP_LEVEL_CAPABILITY_KEYS = new Set([
  'llm',
  'slm',
  'embeddings',
  'memory',
  'tts',
  'stt',
  'reranking',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCapabilityRef(value: unknown, key: 'llm' | 'slm'): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return { ok: false, message: `${key} must be a non-empty "provider/model" string` };
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return { ok: false, message: `${key} must use "provider/model" format` };
  }

  return { ok: true, value: trimmed };
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
  label: string,
): string | null {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return `${label} contains unsupported key "${key}"`;
    }
  }
  return null;
}

function parseEmbeddings(value: unknown): { ok: true; value: Partial<StackSpecEmbeddings> } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: 'embeddings must be an object' };
  }

  const unknownKey = rejectUnknownKeys(value, new Set(['provider', 'model', 'dims']), 'embeddings');
  if (unknownKey) {
    return { ok: false, message: unknownKey };
  }

  const result: Partial<StackSpecEmbeddings> = {};

  if ('provider' in value) {
    const provider = asTrimmedString(value.provider);
    if (!provider) return { ok: false, message: 'embeddings.provider must be a non-empty string' };
    result.provider = provider;
  }

  if ('model' in value) {
    const model = asTrimmedString(value.model);
    if (!model) return { ok: false, message: 'embeddings.model must be a non-empty string' };
    result.model = model;
  }

  if ('dims' in value) {
    if (typeof value.dims !== 'number' || !Number.isInteger(value.dims) || value.dims <= 0) {
      return { ok: false, message: 'embeddings.dims must be a positive integer' };
    }
    result.dims = value.dims;
  }

  return { ok: true, value: result };
}

function parseMemory(value: unknown): { ok: true; value: Partial<StackSpecMemory> } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: 'memory must be an object' };
  }

  const unknownKey = rejectUnknownKeys(value, new Set(['userId', 'customInstructions']), 'memory');
  if (unknownKey) {
    return { ok: false, message: unknownKey };
  }

  const result: Partial<StackSpecMemory> = {};

  if ('userId' in value) {
    if (typeof value.userId !== 'string') {
      return { ok: false, message: 'memory.userId must be a string' };
    }
    result.userId = value.userId;
  }

  if ('customInstructions' in value) {
    if (typeof value.customInstructions !== 'string') {
      return { ok: false, message: 'memory.customInstructions must be a string' };
    }
    result.customInstructions = value.customInstructions;
  }

  return { ok: true, value: result };
}

function parseTts(value: unknown): { ok: true; value: Partial<StackSpecTts> } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: 'tts must be an object' };
  }

  const unknownKey = rejectUnknownKeys(value, new Set(['enabled', 'provider', 'model', 'voice', 'format']), 'tts');
  if (unknownKey) {
    return { ok: false, message: unknownKey };
  }

  const result: Partial<StackSpecTts> = {};
  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') return { ok: false, message: 'tts.enabled must be a boolean' };
    result.enabled = value.enabled;
  }
  for (const key of ['provider', 'model', 'voice', 'format'] as const) {
    if (key in value) {
      if (typeof value[key] !== 'string') return { ok: false, message: `tts.${key} must be a string` };
      result[key] = value[key];
    }
  }
  return { ok: true, value: result };
}

function parseStt(value: unknown): { ok: true; value: Partial<StackSpecStt> } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: 'stt must be an object' };
  }

  const unknownKey = rejectUnknownKeys(value, new Set(['enabled', 'provider', 'model', 'language']), 'stt');
  if (unknownKey) {
    return { ok: false, message: unknownKey };
  }

  const result: Partial<StackSpecStt> = {};
  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') return { ok: false, message: 'stt.enabled must be a boolean' };
    result.enabled = value.enabled;
  }
  for (const key of ['provider', 'model', 'language'] as const) {
    if (key in value) {
      if (typeof value[key] !== 'string') return { ok: false, message: `stt.${key} must be a string` };
      result[key] = value[key];
    }
  }
  return { ok: true, value: result };
}

function parseReranking(value: unknown): { ok: true; value: Partial<StackSpecReranker> } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: 'reranking must be an object' };
  }

  const unknownKey = rejectUnknownKeys(value, new Set(['enabled', 'provider', 'mode', 'model', 'topK', 'topN']), 'reranking');
  if (unknownKey) {
    return { ok: false, message: unknownKey };
  }

  const result: Partial<StackSpecReranker> = {};
  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') return { ok: false, message: 'reranking.enabled must be a boolean' };
    result.enabled = value.enabled;
  }
  if ('mode' in value) {
    if (value.mode !== 'llm' && value.mode !== 'dedicated') {
      return { ok: false, message: 'reranking.mode must be "llm" or "dedicated"' };
    }
    result.mode = value.mode;
  }
  for (const key of ['provider', 'model'] as const) {
    if (key in value) {
      if (typeof value[key] !== 'string') return { ok: false, message: `reranking.${key} must be a string` };
      result[key] = value[key];
    }
  }
  for (const key of ['topK', 'topN'] as const) {
    if (key in value) {
      if (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || value[key] <= 0) {
        return { ok: false, message: `reranking.${key} must be a positive integer` };
      }
      result[key] = value[key];
    }
  }
  return { ok: true, value: result };
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const spec = readStackSpec(state.configDir);
  const capabilities = spec?.capabilities ?? null;

  appendAudit(state, getActor(event), 'connections.assignments.get', {}, true, requestId, getCallerType(event));
  return jsonResponse(200, { capabilities }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, 'invalid_input', 'Request body must be valid JSON', {}, requestId);
  }

  const raw = body.capabilities ?? body;
  if (typeof raw !== 'object' || raw === null) {
    return errorResponse(400, 'bad_request', 'capabilities must be an object', {}, requestId);
  }

  const capabilities = raw as Record<string, unknown>;
  const unknownKey = rejectUnknownKeys(capabilities, TOP_LEVEL_CAPABILITY_KEYS, 'capabilities');
  if (unknownKey) {
    return errorResponse(400, 'bad_request', unknownKey, {}, requestId);
  }

  const spec = readStackSpec(state.configDir);
  if (!spec) {
    return errorResponse(500, 'internal_error', 'stack.yaml not found', {}, requestId);
  }

  if ('llm' in capabilities) {
    const parsed = parseCapabilityRef(capabilities.llm, 'llm');
    if (!parsed.ok) {
      return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
    }
    spec.capabilities.llm = parsed.value;
  }

  if ('slm' in capabilities) {
    if (capabilities.slm === undefined) {
      delete spec.capabilities.slm;
    } else {
      const parsed = parseCapabilityRef(capabilities.slm, 'slm');
      if (!parsed.ok) {
        return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
      }
      spec.capabilities.slm = parsed.value;
    }
  }

  if ('embeddings' in capabilities) {
    const parsed = parseEmbeddings(capabilities.embeddings);
    if (!parsed.ok) {
      return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
    }
    spec.capabilities.embeddings = { ...spec.capabilities.embeddings, ...parsed.value };
  }

  if ('memory' in capabilities) {
    const parsed = parseMemory(capabilities.memory);
    if (!parsed.ok) {
      return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
    }
    spec.capabilities.memory = { ...spec.capabilities.memory, ...parsed.value };
  }

  if ('tts' in capabilities) {
    if (capabilities.tts === undefined) {
      delete spec.capabilities.tts;
    } else {
      const parsed = parseTts(capabilities.tts);
      if (!parsed.ok) {
        return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
      }
      const nextTts = { ...spec.capabilities.tts, ...parsed.value };
      if (typeof nextTts.enabled !== 'boolean') {
        return errorResponse(400, 'bad_request', 'tts.enabled must be a boolean', {}, requestId);
      }
      spec.capabilities.tts = nextTts as StackSpecTts;
    }
  }

  if ('stt' in capabilities) {
    if (capabilities.stt === undefined) {
      delete spec.capabilities.stt;
    } else {
      const parsed = parseStt(capabilities.stt);
      if (!parsed.ok) {
        return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
      }
      const nextStt = { ...spec.capabilities.stt, ...parsed.value };
      if (typeof nextStt.enabled !== 'boolean') {
        return errorResponse(400, 'bad_request', 'stt.enabled must be a boolean', {}, requestId);
      }
      spec.capabilities.stt = nextStt as StackSpecStt;
    }
  }

  if ('reranking' in capabilities) {
    if (capabilities.reranking === undefined) {
      delete spec.capabilities.reranking;
    } else {
      const parsed = parseReranking(capabilities.reranking);
      if (!parsed.ok) {
        return errorResponse(400, 'bad_request', parsed.message, {}, requestId);
      }
      const nextReranking = { ...spec.capabilities.reranking, ...parsed.value };
      if (typeof nextReranking.enabled !== 'boolean') {
        return errorResponse(400, 'bad_request', 'reranking.enabled must be a boolean', {}, requestId);
      }
      spec.capabilities.reranking = nextReranking as StackSpecReranker;
    }
  }

  try {
    writeStackSpec(state.configDir, spec);
    writeManagedEnvFiles(spec, state.vaultDir);
  } catch (err) {
    appendAudit(state, actor, 'connections.assignments.save', { error: String(err) }, false, requestId, callerType);
    return errorResponse(500, 'internal_error', 'Failed to persist capabilities', {}, requestId);
  }

  appendAudit(state, actor, 'connections.assignments.save', {}, true, requestId, callerType);
  return jsonResponse(200, { ok: true, capabilities: spec.capabilities }, requestId);
};
