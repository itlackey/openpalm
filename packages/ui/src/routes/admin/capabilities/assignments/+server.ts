/**
 * GET  /admin/capabilities/assignments — Return current capabilities from stack.yml.
 * POST /admin/capabilities/assignments — Update capabilities in stack.yml.
 */
import type { RequestHandler } from './$types';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { getState } from '$lib/server/state.js';
import {
  appendAudit,
  readStackSpec,
  writeStackSpec,
  writeCapabilityVars,
  buildAkmSetupJson,
  readStackEnv,
  validateCapabilities,
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const spec = readStackSpec(state.stackDir);
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

  const validation = validateCapabilities(raw);
  if (!validation.ok) {
    const first = validation.errors[0];
    return errorResponse(400, 'bad_request', first.message, {}, requestId);
  }

  const spec = readStackSpec(state.stackDir);
  if (!spec) return errorResponse(500, 'internal_error', 'stack.yml not found', {}, requestId);

  // Apply validated partial capabilities onto the existing spec.
  const validated = validation.capabilities;
  if ('llm' in validated && validated.llm !== undefined) spec.capabilities.llm = validated.llm;
  if ('slm' in validated) {
    if (validated.slm === undefined) delete spec.capabilities.slm;
    else spec.capabilities.slm = validated.slm;
  }
  if ('embeddings' in validated && validated.embeddings !== undefined) {
    spec.capabilities.embeddings = { ...spec.capabilities.embeddings, ...validated.embeddings };
  }
  for (const key of ['tts', 'stt', 'reranking', 'akm'] as const) {
    if (!(key in validated)) continue;
    if (validated[key] === undefined) delete (spec.capabilities as Record<string, unknown>)[key];
    else (spec.capabilities as Record<string, unknown>)[key] = {
      ...((spec.capabilities as Record<string, unknown>)[key] as Record<string, unknown>),
      ...(validated[key] as Record<string, unknown>),
    };
  }

  try {
    writeStackSpec(state.stackDir, spec);
    writeCapabilityVars(spec, state.stackDir, state.homeDir);
    const akmJson = buildAkmSetupJson(spec, readStackEnv(state.stackDir));
    if (akmJson) {
      const akmConfigDir = `${state.configDir}/akm`;
      mkdirSync(akmConfigDir, { recursive: true });
      const akmConfigPath = `${akmConfigDir}/config.json`;
      let existing: Record<string, unknown> = {};
      if (existsSync(akmConfigPath)) {
        try { existing = JSON.parse(readFileSync(akmConfigPath, 'utf-8')); } catch { /* ignore corrupt */ }
      }
      const generated = JSON.parse(akmJson) as Record<string, unknown>;
      const merged = { ...existing, ...generated };
      writeFileSync(akmConfigPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
    }
  } catch (e) {
    appendAudit(state, actor, 'capabilities.assignments.save', { error: String(e) }, false, requestId, callerType);
    return errorResponse(500, 'internal_error', 'Failed to persist capabilities', {}, requestId);
  }

  // Note: we deliberately do NOT write `model` / `small_model` to
  // opencode.json from here. OpenCode owns model selection — it falls
  // back to its own default or whatever the user has configured directly.
  // The stack.yml LLM capability is read by writeCapabilityVars and the
  // akm setup, not by OpenCode.

  appendAudit(state, actor, 'capabilities.assignments.save', {}, true, requestId, callerType);
  return jsonResponse(200, { ok: true, capabilities: spec.capabilities }, requestId);
};
