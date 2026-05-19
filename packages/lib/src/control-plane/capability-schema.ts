/**
 * Capability assignment validation.
 *
 * Single source of truth for the shape rules applied when an operator
 * POSTs to /admin/capabilities/assignments. Shared by the UI route and
 * the CLI so both enforce identical constraints.
 *
 * No external schema library — plain TypeScript so lib stays dependency-free.
 */
import type { StackSpecCapabilities } from './stack-spec.js';

export type CapabilityValidationError = { field: string; message: string };

export type CapabilityValidationResult =
  | { ok: true; capabilities: Partial<StackSpecCapabilities> }
  | { ok: false; errors: CapabilityValidationError[] };

const TOP_LEVEL_KEYS = new Set<string>(['llm', 'slm', 'embeddings', 'tts', 'stt', 'reranking', 'akm']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateCapRef(value: unknown, field: string): string | CapabilityValidationError {
  if (typeof value !== 'string' || !value.trim()) {
    return { field, message: `${field} must be a non-empty "provider/model" string` };
  }
  const idx = value.indexOf('/');
  if (idx <= 0 || idx === value.length - 1) {
    return { field, message: `${field} must use "provider/model" format` };
  }
  return value.trim();
}

type FieldType = 'string' | 'number' | 'boolean';
type ObjectResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: CapabilityValidationError };

function validateObject(
  value: unknown,
  field: string,
  required: Record<string, FieldType>,
  optional: Record<string, FieldType>,
): ObjectResult {
  if (!isRecord(value)) return { ok: false, error: { field, message: `${field} must be an object` } };

  for (const [k, expected] of Object.entries(required)) {
    if (!(k in value)) return { ok: false, error: { field: `${field}.${k}`, message: `${field}.${k} is required` } };
    if (expected === 'number') {
      if (typeof value[k] !== 'number' || !Number.isInteger(value[k]) || (value[k] as number) <= 0) {
        return { ok: false, error: { field: `${field}.${k}`, message: `${field}.${k} must be a positive integer` } };
      }
    } else if (typeof value[k] !== expected) {
      return { ok: false, error: { field: `${field}.${k}`, message: `${field}.${k} must be a ${expected}` } };
    }
  }

  const allKnown = { ...required, ...optional };
  for (const k of Object.keys(value)) {
    if (!(k in allKnown)) return { ok: false, error: { field: `${field}.${k}`, message: `${field} contains unsupported key "${k}"` } };
    const expected = allKnown[k];
    if (expected === 'number') {
      if (typeof value[k] !== 'number' || !Number.isInteger(value[k]) || (value[k] as number) <= 0) {
        return { ok: false, error: { field: `${field}.${k}`, message: `${field}.${k} must be a positive integer` } };
      }
    } else if (typeof value[k] !== expected) {
      return { ok: false, error: { field: `${field}.${k}`, message: `${field}.${k} must be a ${expected}` } };
    }
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * Validate and coerce a raw capabilities payload.
 *
 * @param raw - The `capabilities` value from the request body (already confirmed to be a record).
 * @returns Either the validated partial capabilities or a list of field errors.
 */
export function validateCapabilities(raw: Record<string, unknown>): CapabilityValidationResult {
  for (const k of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(k)) {
      return { ok: false, errors: [{ field: k, message: `capabilities contains unsupported key "${k}"` }] };
    }
  }

  const result: Partial<StackSpecCapabilities> = {};

  if ('llm' in raw) {
    const r = validateCapRef(raw.llm, 'llm');
    if (typeof r !== 'string') return { ok: false, errors: [r] };
    result.llm = r;
  }

  if ('slm' in raw) {
    if (raw.slm === undefined || raw.slm === null) {
      result.slm = undefined;
    } else {
      const r = validateCapRef(raw.slm, 'slm');
      if (typeof r !== 'string') return { ok: false, errors: [r] };
      result.slm = r;
    }
  }

  if ('embeddings' in raw) {
    const r = validateObject(raw.embeddings, 'embeddings',
      { provider: 'string', model: 'string', dims: 'number' }, {});
    if (!r.ok) return { ok: false, errors: [r.error] };
    result.embeddings = r.value as StackSpecCapabilities['embeddings'];
  }

  if ('tts' in raw) {
    if (raw.tts === undefined || raw.tts === null) {
      result.tts = undefined;
    } else {
      const r = validateObject(raw.tts, 'tts', {},
        { enabled: 'boolean', engine: 'string', provider: 'string', baseURL: 'string', model: 'string', voice: 'string', format: 'string' });
      if (!r.ok) return { ok: false, errors: [r.error] };
      result.tts = r.value as StackSpecCapabilities['tts'];
    }
  }

  if ('stt' in raw) {
    if (raw.stt === undefined || raw.stt === null) {
      result.stt = undefined;
    } else {
      const r = validateObject(raw.stt, 'stt', {},
        { enabled: 'boolean', engine: 'string', provider: 'string', baseURL: 'string', model: 'string', language: 'string' });
      if (!r.ok) return { ok: false, errors: [r.error] };
      result.stt = r.value as StackSpecCapabilities['stt'];
    }
  }

  if ('reranking' in raw) {
    if (raw.reranking === undefined || raw.reranking === null) {
      result.reranking = undefined;
    } else {
      const r = validateObject(raw.reranking, 'reranking', {},
        { enabled: 'boolean', provider: 'string', mode: 'string', model: 'string', topK: 'number', topN: 'number' });
      if (!r.ok) return { ok: false, errors: [r.error] };
      result.reranking = r.value as StackSpecCapabilities['reranking'];
    }
  }

  if ('akm' in raw) {
    if (raw.akm === undefined || raw.akm === null) {
      result.akm = undefined;
    } else {
      const r = validateObject(raw.akm, 'akm', {},
        { feedback_distillation: 'boolean', memory_inference: 'boolean', memory_consolidation: 'boolean' });
      if (!r.ok) return { ok: false, errors: [r.error] };
      result.akm = r.value as StackSpecCapabilities['akm'];
    }
  }

  return { ok: true, capabilities: result };
}
