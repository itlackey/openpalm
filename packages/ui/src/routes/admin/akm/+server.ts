/**
 * GET  /admin/akm  — Return current akm config from OP_HOME/config/akm/config.json
 * PATCH /admin/akm — Update the user-editable fields in the akm config
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

  // Validate each allowed field
  if ('semanticSearchMode' in body) {
    if (typeof body.semanticSearchMode !== 'string' || !SEMANTIC_SEARCH_MODES.has(body.semanticSearchMode)) {
      return errorResponse(400, 'bad_request', 'semanticSearchMode must be "auto" or "off"', {}, requestId);
    }
  }

  if ('archiveRetentionDays' in body) {
    const v = body.archiveRetentionDays;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 365) {
      return errorResponse(400, 'bad_request', 'archiveRetentionDays must be an integer 1–365', {}, requestId);
    }
  }

  const outputObj = body.output as Record<string, unknown> | undefined;
  if (outputObj !== undefined) {
    if (typeof outputObj !== 'object' || outputObj === null || Array.isArray(outputObj)) {
      return errorResponse(400, 'bad_request', 'output must be an object', {}, requestId);
    }
    if ('format' in outputObj && (typeof outputObj.format !== 'string' || !OUTPUT_FORMATS.has(outputObj.format as string))) {
      return errorResponse(400, 'bad_request', 'output.format must be "json", "yaml", or "text"', {}, requestId);
    }
  }

  const defaultsObj = body.defaults as Record<string, unknown> | undefined;
  if (defaultsObj !== undefined) {
    if (typeof defaultsObj !== 'object' || defaultsObj === null || Array.isArray(defaultsObj)) {
      return errorResponse(400, 'bad_request', 'defaults must be an object', {}, requestId);
    }
    const improveObj = defaultsObj.improve as Record<string, unknown> | undefined;
    if (improveObj !== undefined) {
      if ('limit' in improveObj) {
        const v = improveObj.limit;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100) {
          return errorResponse(400, 'bad_request', 'defaults.improve.limit must be an integer 1–100', {}, requestId);
        }
      }
      if ('preset' in improveObj && (typeof improveObj.preset !== 'string' || !IMPROVE_PRESETS.has(improveObj.preset as string))) {
        return errorResponse(400, 'bad_request', 'defaults.improve.preset must be "fast", "thorough", "mixed", or "custom"', {}, requestId);
      }
    }
  }

  const searchObj = body.search as Record<string, unknown> | undefined;
  if (searchObj !== undefined) {
    if (typeof searchObj !== 'object' || searchObj === null || Array.isArray(searchObj)) {
      return errorResponse(400, 'bad_request', 'search must be an object', {}, requestId);
    }
    if ('minScore' in searchObj) {
      const v = searchObj.minScore;
      if (typeof v !== 'number' || v < 0 || v > 1) {
        return errorResponse(400, 'bad_request', 'search.minScore must be a number between 0 and 1', {}, requestId);
      }
    }
  }

  try {
    const existing = readAkmConfig(state.configDir);

    // Deep-merge nested objects; scalar fields are replaced directly
    const updated: Record<string, unknown> = { ...existing };

    if ('semanticSearchMode' in body) updated.semanticSearchMode = body.semanticSearchMode;
    if ('archiveRetentionDays' in body) updated.archiveRetentionDays = body.archiveRetentionDays;

    if (outputObj !== undefined) {
      updated.output = { ...(existing.output as Record<string, unknown> ?? {}), ...outputObj };
    }

    if (defaultsObj !== undefined) {
      const existingDefaults = (existing.defaults as Record<string, unknown> ?? {});
      const improveObj2 = defaultsObj.improve as Record<string, unknown> | undefined;
      const existingImprove = (existingDefaults.improve as Record<string, unknown> ?? {});
      updated.defaults = {
        ...existingDefaults,
        ...defaultsObj,
        ...(improveObj2 !== undefined ? { improve: { ...existingImprove, ...improveObj2 } } : {}),
      };
    }

    if (searchObj !== undefined) {
      updated.search = { ...(existing.search as Record<string, unknown> ?? {}), ...searchObj };
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
