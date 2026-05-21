/**
 * GET  /admin/akm  — Return current akm config from OP_HOME/config/akm/config.json
 * PATCH /admin/akm — Update config fields (profiles, connections, features, behavior, tuning)
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

type Rec = Record<string, unknown>;

function akmConfigPath(configDir: string): string {
  return `${configDir}/akm/config.json`;
}

function readAkmConfig(configDir: string): Rec {
  const path = akmConfigPath(configDir);
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Rec; } catch { return {}; }
}

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Validation helpers ───────────────────────────────────────────────────────

function expectStr(v: unknown, field: string): string | Error {
  return typeof v === 'string' ? v : new Error(`${field} must be a string`);
}

function expectBool(v: unknown, field: string): boolean | Error {
  return typeof v === 'boolean' ? v : new Error(`${field} must be a boolean`);
}

function expectPosInt(v: unknown, field: string): number | Error {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : new Error(`${field} must be a positive integer`);
}

function expectNum(v: unknown, field: string, min: number, max: number): number | Error {
  return typeof v === 'number' && v >= min && v <= max ? v : new Error(`${field} must be a number between ${min} and ${max}`);
}

function validateLlmProfile(raw: Rec, prefix: string): Error | null {
  if ('endpoint' in raw) { const r = expectStr(raw.endpoint, `${prefix}.endpoint`); if (r instanceof Error) return r; }
  if ('model' in raw) { const r = expectStr(raw.model, `${prefix}.model`); if (r instanceof Error) return r; }
  if ('provider' in raw) { const r = expectStr(raw.provider, `${prefix}.provider`); if (r instanceof Error) return r; }
  if ('apiKey' in raw) { const r = expectStr(raw.apiKey, `${prefix}.apiKey`); if (r instanceof Error) return r; }
  if ('judgeModel' in raw) { const r = expectStr(raw.judgeModel, `${prefix}.judgeModel`); if (r instanceof Error) return r; }
  if ('temperature' in raw) { const r = expectNum(raw.temperature, `${prefix}.temperature`, 0, 2); if (r instanceof Error) return r; }
  if ('maxTokens' in raw) { const r = expectPosInt(raw.maxTokens, `${prefix}.maxTokens`); if (r instanceof Error) return r; }
  if ('timeoutMs' in raw) { const r = expectPosInt(raw.timeoutMs, `${prefix}.timeoutMs`); if (r instanceof Error) return r; }
  if ('concurrency' in raw) { const r = expectPosInt(raw.concurrency, `${prefix}.concurrency`); if (r instanceof Error) return r; }
  if ('contextLength' in raw) { const r = expectPosInt(raw.contextLength, `${prefix}.contextLength`); if (r instanceof Error) return r; }
  if ('supportsJsonSchema' in raw) { const r = expectBool(raw.supportsJsonSchema, `${prefix}.supportsJsonSchema`); if (r instanceof Error) return r; }
  if ('features' in raw) {
    if (!isRec(raw.features)) return new Error(`${prefix}.features must be an object`);
    for (const k of ['memory_inference','memory_consolidation','feedback_distillation','graph_extraction','curate_rerank','lesson_quality_gate','proposal_quality_gate','metadata_enhance','memory_contradiction_detection']) {
      if (k in raw.features) { const r = expectBool((raw.features as Rec)[k], `${prefix}.features.${k}`); if (r instanceof Error) return r; }
    }
  }
  return null;
}

function pickLlmProfile(raw: Rec): Rec {
  const out: Rec = {};
  const strFields = ['endpoint','model','provider','judgeModel'] as const;
  for (const f of strFields) if (f in raw && raw[f]) out[f] = raw[f];
  // apiKey: write if non-empty, omit to clear
  if ('apiKey' in raw) { if (raw.apiKey) out.apiKey = raw.apiKey; }
  const numFields = ['temperature','maxTokens','timeoutMs','concurrency','contextLength'] as const;
  for (const f of numFields) if (f in raw && raw[f] !== undefined) out[f] = raw[f];
  if ('supportsJsonSchema' in raw) out.supportsJsonSchema = raw.supportsJsonSchema;
  if ('features' in raw && isRec(raw.features)) {
    const feats: Rec = {};
    for (const k of ['memory_inference','memory_consolidation','feedback_distillation','graph_extraction','curate_rerank','lesson_quality_gate','proposal_quality_gate','metadata_enhance','memory_contradiction_detection']) {
      if (k in raw.features) feats[k] = (raw.features as Rec)[k];
    }
    out.features = feats;
  }
  return out;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  return jsonResponse(200, { config: readAkmConfig(state.configDir) }, requestId);
};

const SEMANTIC_SEARCH_MODES = new Set(['auto','off']);
const OUTPUT_FORMATS = new Set(['json','yaml','text']);
const OUTPUT_DETAILS = new Set(['brief','normal','full']);
const IMPROVE_PRESETS = new Set(['fast','thorough','mixed','custom']);
const STASH_INHERITANCE = new Set(['merge','replace']);
const AGENT_PLATFORMS = new Set(['opencode','claude','opencode-sdk']);
const CONFIDENCE_MODES = new Set(['off','blend','multiply']);

export const PATCH: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data as Rec;

  // ── profiles ──────────────────────────────────────────────────────────────
  const profilesBody = body.profiles as Rec | undefined;
  if (profilesBody !== undefined && !isRec(profilesBody))
    return errorResponse(400, 'bad_request', 'profiles must be an object', {}, requestId);

  const profilesLlmBody = profilesBody?.llm as Rec | undefined;
  if (profilesLlmBody !== undefined) {
    if (!isRec(profilesLlmBody)) return errorResponse(400, 'bad_request', 'profiles.llm must be an object', {}, requestId);
    for (const [name, entry] of Object.entries(profilesLlmBody)) {
      if (!isRec(entry)) return errorResponse(400, 'bad_request', `profiles.llm.${name} must be an object`, {}, requestId);
      const err = validateLlmProfile(entry, `profiles.llm.${name}`);
      if (err) return errorResponse(400, 'bad_request', err.message, {}, requestId);
    }
  }

  const profilesAgentBody = profilesBody?.agent as Rec | undefined;
  if (profilesAgentBody !== undefined) {
    if (!isRec(profilesAgentBody)) return errorResponse(400, 'bad_request', 'profiles.agent must be an object', {}, requestId);
    for (const [name, entry] of Object.entries(profilesAgentBody)) {
      if (!isRec(entry)) return errorResponse(400, 'bad_request', `profiles.agent.${name} must be an object`, {}, requestId);
      if ('platform' in entry && (typeof entry.platform !== 'string' || !AGENT_PLATFORMS.has(entry.platform as string)))
        return errorResponse(400, 'bad_request', `profiles.agent.${name}.platform must be opencode, claude, or opencode-sdk`, {}, requestId);
      if ('bin' in entry) { const r = expectStr(entry.bin, `profiles.agent.${name}.bin`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
      if ('workspace' in entry) { const r = expectStr(entry.workspace, `profiles.agent.${name}.workspace`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
      if ('model' in entry) { const r = expectStr(entry.model, `profiles.agent.${name}.model`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
      if ('args' in entry && !Array.isArray(entry.args)) return errorResponse(400, 'bad_request', `profiles.agent.${name}.args must be an array`, {}, requestId);
    }
  }

  // ── defaults ──────────────────────────────────────────────────────────────
  const defaultsBody = body.defaults as Rec | undefined;
  if (defaultsBody !== undefined && !isRec(defaultsBody))
    return errorResponse(400, 'bad_request', 'defaults must be an object', {}, requestId);
  if (defaultsBody?.llm !== undefined) { const r = expectStr(defaultsBody.llm, 'defaults.llm'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
  if (defaultsBody?.agent !== undefined) { const r = expectStr(defaultsBody.agent, 'defaults.agent'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
  const improveBody = defaultsBody?.improve as Rec | undefined;
  if (improveBody !== undefined) {
    if (!isRec(improveBody)) return errorResponse(400, 'bad_request', 'defaults.improve must be an object', {}, requestId);
    if ('limit' in improveBody) { const r = expectPosInt(improveBody.limit, 'defaults.improve.limit'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
    if ('preset' in improveBody && (typeof improveBody.preset !== 'string' || !IMPROVE_PRESETS.has(improveBody.preset as string)))
      return errorResponse(400, 'bad_request', 'defaults.improve.preset must be fast, thorough, mixed, or custom', {}, requestId);
  }

  // ── features ──────────────────────────────────────────────────────────────
  const featuresBody = body.features as Rec | undefined;
  if (featuresBody !== undefined) {
    if (!isRec(featuresBody)) return errorResponse(400, 'bad_request', 'features must be an object', {}, requestId);
    const FEAT_MODES = new Set(['llm','agent','sdk']);
    for (const section of ['improve','index','search']) {
      const sec = featuresBody[section] as Rec | undefined;
      if (sec === undefined) continue;
      if (!isRec(sec)) return errorResponse(400, 'bad_request', `features.${section} must be an object`, {}, requestId);
      for (const [op, entry] of Object.entries(sec)) {
        if (typeof entry === 'boolean') continue;
        if (!isRec(entry)) return errorResponse(400, 'bad_request', `features.${section}.${op} must be boolean or a config object`, {}, requestId);
        if ('enabled' in entry) { const r = expectBool(entry.enabled, `features.${section}.${op}.enabled`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
        if ('mode' in entry && (typeof entry.mode !== 'string' || !FEAT_MODES.has(entry.mode as string)))
          return errorResponse(400, 'bad_request', `features.${section}.${op}.mode must be llm, agent, or sdk`, {}, requestId);
        if ('profile' in entry) { const r = expectStr(entry.profile, `features.${section}.${op}.profile`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
        if ('timeoutMs' in entry && entry.timeoutMs !== null) { const r = expectPosInt(entry.timeoutMs, `features.${section}.${op}.timeoutMs`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
      }
    }
  }

  // ── embedding ─────────────────────────────────────────────────────────────
  const embBody = body.embedding as Rec | undefined;
  if (embBody !== undefined) {
    if (!isRec(embBody)) return errorResponse(400, 'bad_request', 'embedding must be an object', {}, requestId);
    const strFields = ['endpoint','model','provider','apiKey','localModel'] as const;
    for (const f of strFields) {
      if (f in embBody) { const r = expectStr(embBody[f], `embedding.${f}`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
    }
    if ('dimension' in embBody) { const r = expectPosInt(embBody.dimension, 'embedding.dimension'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
    const posIntFields = ['maxTokens','batchSize','chunkSize','contextLength'] as const;
    for (const f of posIntFields) {
      if (f in embBody) { const r = expectPosInt(embBody[f], `embedding.${f}`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
    }
    if (isRec(embBody.ollamaOptions) && 'num_ctx' in embBody.ollamaOptions) {
      const r = expectPosInt((embBody.ollamaOptions as Rec).num_ctx, 'embedding.ollamaOptions.num_ctx');
      if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId);
    }
  }

  // ── scalar behavior fields ────────────────────────────────────────────────
  if ('semanticSearchMode' in body && (typeof body.semanticSearchMode !== 'string' || !SEMANTIC_SEARCH_MODES.has(body.semanticSearchMode as string)))
    return errorResponse(400, 'bad_request', 'semanticSearchMode must be "auto" or "off"', {}, requestId);
  if ('archiveRetentionDays' in body) {
    if (typeof body.archiveRetentionDays !== 'number' || !Number.isInteger(body.archiveRetentionDays) || body.archiveRetentionDays < 0)
      return errorResponse(400, 'bad_request', 'archiveRetentionDays must be a non-negative integer', {}, requestId);
  }
  if ('stashInheritance' in body && (typeof body.stashInheritance !== 'string' || !STASH_INHERITANCE.has(body.stashInheritance as string)))
    return errorResponse(400, 'bad_request', 'stashInheritance must be "merge" or "replace"', {}, requestId);
  if ('stashDir' in body) { const r = expectStr(body.stashDir, 'stashDir'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
  if ('defaultWriteTarget' in body) { const r = expectStr(body.defaultWriteTarget, 'defaultWriteTarget'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }

  // ── output ────────────────────────────────────────────────────────────────
  const outputBody = body.output as Rec | undefined;
  if (outputBody !== undefined) {
    if (!isRec(outputBody)) return errorResponse(400, 'bad_request', 'output must be an object', {}, requestId);
    if ('format' in outputBody && (typeof outputBody.format !== 'string' || !OUTPUT_FORMATS.has(outputBody.format as string)))
      return errorResponse(400, 'bad_request', 'output.format must be json, yaml, or text', {}, requestId);
    if ('detail' in outputBody && (typeof outputBody.detail !== 'string' || !OUTPUT_DETAILS.has(outputBody.detail as string)))
      return errorResponse(400, 'bad_request', 'output.detail must be brief, normal, or full', {}, requestId);
  }

  // ── improve (top-level pipeline tuning) ──────────────────────────────────
  const improveTopBody = body.improve as Rec | undefined;
  if (improveTopBody !== undefined) {
    if (!isRec(improveTopBody)) return errorResponse(400, 'bad_request', 'improve must be an object', {}, requestId);
    if ('reflectCooldownByType' in improveTopBody && !isRec(improveTopBody.reflectCooldownByType))
      return errorResponse(400, 'bad_request', 'improve.reflectCooldownByType must be an object', {}, requestId);
    if (isRec(improveTopBody.reflectCooldownByType)) {
      for (const [k, v] of Object.entries(improveTopBody.reflectCooldownByType as Rec)) {
        if (typeof v !== 'number' || v < 0) return errorResponse(400, 'bad_request', `improve.reflectCooldownByType.${k} must be a non-negative number`, {}, requestId);
      }
    }
    if ('utilityDecay' in improveTopBody) {
      const ud = improveTopBody.utilityDecay as Rec;
      if (!isRec(ud)) return errorResponse(400, 'bad_request', 'improve.utilityDecay must be an object', {}, requestId);
      if ('halfLifeDays' in ud && (typeof ud.halfLifeDays !== 'number' || ud.halfLifeDays < 0.1))
        return errorResponse(400, 'bad_request', 'improve.utilityDecay.halfLifeDays must be >= 0.1', {}, requestId);
      if ('feedbackStabilityBoost' in ud && (typeof ud.feedbackStabilityBoost !== 'number' || ud.feedbackStabilityBoost < 1))
        return errorResponse(400, 'bad_request', 'improve.utilityDecay.feedbackStabilityBoost must be >= 1', {}, requestId);
    }
  }

  // ── search ────────────────────────────────────────────────────────────────
  const searchBody = body.search as Rec | undefined;
  if (searchBody !== undefined) {
    if (!isRec(searchBody)) return errorResponse(400, 'bad_request', 'search must be an object', {}, requestId);
    if ('minScore' in searchBody) { const r = expectNum(searchBody.minScore, 'search.minScore', 0, 1); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
    if ('graphBoost' in searchBody && isRec(searchBody.graphBoost)) {
      const gb = searchBody.graphBoost as Rec;
      const numFields = ['directBoostPerEntity','directBoostCap','hopBoostPerEntity','hopBoostCap','confidenceWeight'] as const;
      for (const f of numFields) {
        if (f in gb && typeof gb[f] !== 'number') return errorResponse(400, 'bad_request', `search.graphBoost.${f} must be a number`, {}, requestId);
      }
      if ('maxHops' in gb) { const r = expectPosInt(gb.maxHops, 'search.graphBoost.maxHops'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
      if ('confidenceMode' in gb && (typeof gb.confidenceMode !== 'string' || !CONFIDENCE_MODES.has(gb.confidenceMode as string)))
        return errorResponse(400, 'bad_request', 'search.graphBoost.confidenceMode must be off, blend, or multiply', {}, requestId);
    }
  }

  // ── feedback ──────────────────────────────────────────────────────────────
  const feedbackBody = body.feedback as Rec | undefined;
  if (feedbackBody !== undefined) {
    if (!isRec(feedbackBody)) return errorResponse(400, 'bad_request', 'feedback must be an object', {}, requestId);
    if ('requireReason' in feedbackBody) { const r = expectBool(feedbackBody.requireReason, 'feedback.requireReason'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
    if ('allowedFailureModes' in feedbackBody && !Array.isArray(feedbackBody.allowedFailureModes))
      return errorResponse(400, 'bad_request', 'feedback.allowedFailureModes must be an array', {}, requestId);
  }

  // ── Merge and write ───────────────────────────────────────────────────────
  try {
    const existing = readAkmConfig(state.configDir);
    const updated: Rec = { ...existing };

    // profiles
    if (profilesBody !== undefined) {
      const existingProfiles = (existing.profiles as Rec) ?? {};
      const newProfiles: Rec = { ...existingProfiles };
      if (profilesLlmBody !== undefined) {
        const built: Rec = {};
        for (const [name, entry] of Object.entries(profilesLlmBody)) {
          built[name] = pickLlmProfile(entry as Rec);
        }
        newProfiles.llm = built;
      }
      if (profilesAgentBody !== undefined) {
        const built: Rec = {};
        for (const [name, entry] of Object.entries(profilesAgentBody)) {
          const raw = entry as Rec;
          const agentEntry: Rec = {};
          if ('platform' in raw) agentEntry.platform = raw.platform;
          if ('bin' in raw && raw.bin) agentEntry.bin = raw.bin;
          if ('args' in raw && Array.isArray(raw.args) && (raw.args as unknown[]).length) agentEntry.args = raw.args;
          if ('workspace' in raw && raw.workspace) agentEntry.workspace = raw.workspace;
          if ('model' in raw && raw.model) agentEntry.model = raw.model;
          built[name] = agentEntry;
        }
        newProfiles.agent = built;
      }
      updated.profiles = newProfiles;
    }

    // defaults
    if (defaultsBody !== undefined) {
      const existingDefaults = (existing.defaults as Rec) ?? {};
      const existingImprove = (existingDefaults.improve as Rec) ?? {};
      const mergedImprove = improveBody !== undefined
        ? {
            ...existingImprove,
            ...('limit' in improveBody ? { limit: improveBody.limit } : {}),
            ...('preset' in improveBody ? { preset: improveBody.preset } : {}),
          }
        : existingImprove;
      updated.defaults = {
        ...existingDefaults,
        ...('llm' in defaultsBody ? { llm: defaultsBody.llm } : {}),
        ...('agent' in defaultsBody ? { agent: defaultsBody.agent } : {}),
        improve: mergedImprove,
      };
    }

    // features (v2 — merge per-section per-operation)
    if (featuresBody !== undefined) {
      const existingFeatures = (existing.features as Rec) ?? {};
      const newFeatures: Rec = { ...existingFeatures };
      for (const section of ['improve','index','search']) {
        const secBody = featuresBody[section] as Rec | undefined;
        if (!secBody || !isRec(secBody)) continue;
        const existingSec = (existingFeatures[section] as Rec) ?? {};
        const newSec: Rec = { ...existingSec };
        for (const [op, entry] of Object.entries(secBody)) {
          if (typeof entry === 'boolean') { newSec[op] = entry; continue; }
          if (!isRec(entry)) continue;
          const existingOp = (existingSec[op] as Rec) ?? {};
          const mergedOp: Rec = { ...existingOp };
          if ('enabled' in entry) mergedOp.enabled = entry.enabled;
          if ('mode' in entry) { if (entry.mode) mergedOp.mode = entry.mode; else delete mergedOp.mode; }
          if ('profile' in entry) { if (entry.profile) mergedOp.profile = entry.profile; else delete mergedOp.profile; }
          if ('timeoutMs' in entry) { if (entry.timeoutMs !== null && entry.timeoutMs !== undefined) mergedOp.timeoutMs = entry.timeoutMs; else mergedOp.timeoutMs = null; }
          newSec[op] = mergedOp;
        }
        newFeatures[section] = newSec;
      }
      updated.features = newFeatures;
    }

    // embedding
    if (embBody !== undefined) {
      const existingEmb = (existing.embedding as Rec) ?? {};
      const merged: Rec = { ...existingEmb };
      for (const f of ['endpoint','model','provider','localModel']) {
        if (f in embBody) { if (embBody[f]) merged[f] = embBody[f]; else delete merged[f]; }
      }
      if ('apiKey' in embBody) { if (embBody.apiKey) merged.apiKey = embBody.apiKey; else delete merged.apiKey; }
      if ('dimension' in embBody) merged.dimension = embBody.dimension;
      for (const f of ['maxTokens','batchSize','chunkSize','contextLength'] as const) {
        if (f in embBody) merged[f] = embBody[f];
      }
      if (isRec(embBody.ollamaOptions) && 'num_ctx' in embBody.ollamaOptions) {
        merged.ollamaOptions = { ...(existing.embedding as Rec | undefined)?.['ollamaOptions'] as Rec ?? {}, num_ctx: (embBody.ollamaOptions as Rec).num_ctx };
      }
      updated.embedding = merged;
    }

    // scalars
    if ('semanticSearchMode' in body) updated.semanticSearchMode = body.semanticSearchMode;
    if ('archiveRetentionDays' in body) updated.archiveRetentionDays = body.archiveRetentionDays;
    if ('stashInheritance' in body) updated.stashInheritance = body.stashInheritance;
    if ('stashDir' in body) { if (body.stashDir) updated.stashDir = body.stashDir; else delete updated.stashDir; }
    if ('defaultWriteTarget' in body) { if (body.defaultWriteTarget) updated.defaultWriteTarget = body.defaultWriteTarget; else delete updated.defaultWriteTarget; }

    // output
    if (outputBody !== undefined) {
      const existingOutput = (existing.output as Rec) ?? {};
      updated.output = {
        ...existingOutput,
        ...('format' in outputBody ? { format: outputBody.format } : {}),
        ...('detail' in outputBody ? { detail: outputBody.detail } : {}),
      };
    }

    // improve (top-level pipeline)
    if (improveTopBody !== undefined) {
      const existingImproveTop = (existing.improve as Rec) ?? {};
      const existingDecay = (existingImproveTop.utilityDecay as Rec) ?? {};
      const udBody = improveTopBody.utilityDecay as Rec | undefined;
      const mergedDecay = udBody !== undefined
        ? {
            ...existingDecay,
            ...('halfLifeDays' in udBody ? { halfLifeDays: udBody.halfLifeDays } : {}),
            ...('feedbackStabilityBoost' in udBody ? { feedbackStabilityBoost: udBody.feedbackStabilityBoost } : {}),
          }
        : existingDecay;
      updated.improve = {
        ...existingImproveTop,
        ...('reflectCooldownByType' in improveTopBody ? { reflectCooldownByType: improveTopBody.reflectCooldownByType } : {}),
        utilityDecay: mergedDecay,
      };
    }

    // search
    if (searchBody !== undefined) {
      const existingSearch = (existing.search as Rec) ?? {};
      const existingGb = (existingSearch.graphBoost as Rec) ?? {};
      const gbBody = searchBody.graphBoost as Rec | undefined;
      const mergedGb = gbBody !== undefined
        ? {
            ...existingGb,
            ...(['directBoostPerEntity','directBoostCap','hopBoostPerEntity','hopBoostCap','maxHops','confidenceMode','confidenceWeight']
              .reduce((acc, k) => { if (k in gbBody) acc[k] = gbBody[k]; return acc; }, {} as Rec)),
          }
        : existingGb;
      updated.search = {
        ...existingSearch,
        ...('minScore' in searchBody ? { minScore: searchBody.minScore } : {}),
        ...( gbBody !== undefined ? { graphBoost: mergedGb } : {}),
      };
    }

    // feedback
    if (feedbackBody !== undefined) {
      const existingFeedback = (existing.feedback as Rec) ?? {};
      updated.feedback = {
        ...existingFeedback,
        ...('requireReason' in feedbackBody ? { requireReason: feedbackBody.requireReason } : {}),
        ...('allowedFailureModes' in feedbackBody ? { allowedFailureModes: feedbackBody.allowedFailureModes } : {}),
      };
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
