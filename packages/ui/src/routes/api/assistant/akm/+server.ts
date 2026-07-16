/**
 * GET  /api/assistant/akm  — Return current akm config from OP_HOME/config/akm/config.json
 * PATCH /api/assistant/akm — Update config fields aligned with AKM 0.8.0 schema
 *
 * Assistant-SCOPED AKM configuration: config/akm/config.json holds the assistant's AKM settings.
 * Assistant settings are a BASE capability (every process), so the browser can
 * read/write this config regardless of admin capability; guarded by the
 * assistant-settings capabilities in addition to requireAdmin.
 * Host-LEVEL AKM (host key sharing) stays at /api/host/akm/host-sharing.
 */
import type { RequestHandler } from './$types';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { writeFileAtomic } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  parseJsonBody,
  jsonBodyError,
  requireAdmin,
  requireCapability,
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
  if ('enableThinking' in raw) { const r = expectBool(raw.enableThinking, `${prefix}.enableThinking`); if (r instanceof Error) return r; }
  if ('capabilities' in raw) {
    if (!isRec(raw.capabilities)) return new Error(`${prefix}.capabilities must be an object`);
    if ('structuredOutput' in raw.capabilities) { const r = expectBool((raw.capabilities as Rec).structuredOutput, `${prefix}.capabilities.structuredOutput`); if (r instanceof Error) return r; }
  }
  if ('extraParams' in raw && !isRec(raw.extraParams)) return new Error(`${prefix}.extraParams must be an object`);
  return null;
}

function pickLlmProfile(raw: Rec): Rec {
  const out: Rec = {};
  const strFields = ['endpoint','model','provider','judgeModel'] as const;
  for (const f of strFields) if (f in raw && raw[f]) out[f] = raw[f];
  if ('apiKey' in raw) { if (raw.apiKey) out.apiKey = raw.apiKey; }
  const numFields = ['temperature','maxTokens','timeoutMs','concurrency','contextLength'] as const;
  for (const f of numFields) if (f in raw && raw[f] !== undefined) out[f] = raw[f];
  if ('supportsJsonSchema' in raw) out.supportsJsonSchema = raw.supportsJsonSchema;
  if ('enableThinking' in raw) out.enableThinking = raw.enableThinking;
  if (isRec(raw.capabilities) && Object.keys(raw.capabilities as Rec).length) out.capabilities = raw.capabilities;
  if (isRec(raw.extraParams) && Object.keys(raw.extraParams as Rec).length) out.extraParams = raw.extraParams;
  return out;
}

const ALLOWED_IMPROVE_PROCESSES = new Set(['reflect','distill','consolidate','memoryInference','graphExtraction','validation','extract','triage']);
const APPLY_MODES = new Set(['queue','promote']);
const FEAT_MODES = new Set(['llm','agent','sdk']);
const AGENT_PLATFORMS = new Set(['opencode','claude','opencode-sdk']);
const SEMANTIC_SEARCH_MODES = new Set(['auto','off']);
const OUTPUT_FORMATS = new Set(['json','yaml','text']);
const OUTPUT_DETAILS = new Set(['brief','normal','full']);

function validateEnabledGate(v: unknown, path: string): Error | null {
  if (!isRec(v)) return new Error(`${path} must be an object`);
  if ('enabled' in v) { const r = expectBool(v.enabled, `${path}.enabled`); if (r instanceof Error) return r; }
  return null;
}

function validateImproveProcess(proc: Rec, path: string): Error | null {
  if ('enabled' in proc) { const r = expectBool(proc.enabled, `${path}.enabled`); if (r instanceof Error) return r; }
  if ('mode' in proc && (typeof proc.mode !== 'string' || !FEAT_MODES.has(proc.mode as string)))
    return new Error(`${path}.mode must be llm, agent, or sdk`);
  if ('profile' in proc) { const r = expectStr(proc.profile, `${path}.profile`); if (r instanceof Error) return r; }
  if ('timeoutMs' in proc && proc.timeoutMs !== null) { const r = expectPosInt(proc.timeoutMs, `${path}.timeoutMs`); if (r instanceof Error) return r; }
  // advanced (akm ImproveProcessConfigSchema)
  if ('allowedTypes' in proc) {
    if (!Array.isArray(proc.allowedTypes) || !proc.allowedTypes.every((t) => typeof t === 'string' && t.length > 0))
      return new Error(`${path}.allowedTypes must be an array of non-empty strings`);
  }
  if ('qualityGate' in proc) { const r = validateEnabledGate(proc.qualityGate, `${path}.qualityGate`); if (r) return r; }
  if ('contradictionDetection' in proc) { const r = validateEnabledGate(proc.contradictionDetection, `${path}.contradictionDetection`); if (r) return r; }
  // extract
  if ('defaultSince' in proc) { const r = expectStr(proc.defaultSince, `${path}.defaultSince`); if (r instanceof Error) return r; }
  if ('maxTotalChars' in proc) { const r = expectPosInt(proc.maxTotalChars, `${path}.maxTotalChars`); if (r instanceof Error) return r; }
  if ('maxChunkSize' in proc) {
    if (typeof proc.maxChunkSize !== 'number' || !Number.isInteger(proc.maxChunkSize) || proc.maxChunkSize < 1 || proc.maxChunkSize > 50)
      return new Error(`${path}.maxChunkSize must be an integer 1–50`);
  }
  // triage
  if ('applyMode' in proc && (typeof proc.applyMode !== 'string' || !APPLY_MODES.has(proc.applyMode as string)))
    return new Error(`${path}.applyMode must be queue or promote`);
  if ('policy' in proc) { const r = expectStr(proc.policy, `${path}.policy`); if (r instanceof Error) return r; }
  if ('maxAcceptsPerRun' in proc) { const r = expectPosInt(proc.maxAcceptsPerRun, `${path}.maxAcceptsPerRun`); if (r instanceof Error) return r; }
  if ('maxDiffLines' in proc) { const r = expectPosInt(proc.maxDiffLines, `${path}.maxDiffLines`); if (r instanceof Error) return r; }
  if ('rejectEmpty' in proc) { const r = expectBool(proc.rejectEmpty, `${path}.rejectEmpty`); if (r instanceof Error) return r; }
  if ('judgment' in proc) {
    if (!isRec(proc.judgment)) return new Error(`${path}.judgment must be an object`);
    const j = proc.judgment as Rec;
    if ('mode' in j && (typeof j.mode !== 'string' || !FEAT_MODES.has(j.mode as string))) return new Error(`${path}.judgment.mode must be llm, agent, or sdk`);
    if ('profile' in j) { const r = expectStr(j.profile, `${path}.judgment.profile`); if (r instanceof Error) return r; }
    if ('timeoutMs' in j && j.timeoutMs !== null) { const r = expectPosInt(j.timeoutMs, `${path}.judgment.timeoutMs`); if (r instanceof Error) return r; }
  }
  return null;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'assistant-settings:read', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  return jsonResponse(200, { config: readAkmConfig(state.configDir) }, requestId);
};

export const PATCH: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'assistant-settings:write', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();

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

  // profiles.improve — named improve profiles (0.8.0 schema)
  const profilesImproveBody = profilesBody?.improve as Rec | undefined;
  if (profilesImproveBody !== undefined) {
    if (!isRec(profilesImproveBody)) return errorResponse(400, 'bad_request', 'profiles.improve must be an object', {}, requestId);
    for (const [name, entry] of Object.entries(profilesImproveBody)) {
      if (!isRec(entry)) return errorResponse(400, 'bad_request', `profiles.improve.${name} must be an object`, {}, requestId);
      if ('description' in entry) { const r = expectStr(entry.description, `profiles.improve.${name}.description`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
      if ('limit' in entry) { const r = expectPosInt(entry.limit, `profiles.improve.${name}.limit`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
      if ('autoAccept' in entry && (typeof entry.autoAccept !== 'number' || entry.autoAccept < 0))
        return errorResponse(400, 'bad_request', `profiles.improve.${name}.autoAccept must be a non-negative number`, {}, requestId);
      if ('processes' in entry) {
        if (!isRec(entry.processes)) return errorResponse(400, 'bad_request', `profiles.improve.${name}.processes must be an object`, {}, requestId);
        for (const [procName, proc] of Object.entries(entry.processes as Rec)) {
          if (!ALLOWED_IMPROVE_PROCESSES.has(procName))
            return errorResponse(400, 'bad_request', `profiles.improve.${name}.processes.${procName} is not a recognized process name`, {}, requestId);
          if (!isRec(proc)) return errorResponse(400, 'bad_request', `profiles.improve.${name}.processes.${procName} must be an object`, {}, requestId);
          const err = validateImproveProcess(proc as Rec, `profiles.improve.${name}.processes.${procName}`);
          if (err) return errorResponse(400, 'bad_request', err.message, {}, requestId);
        }
      }
      if ('sync' in entry) {
        if (!isRec(entry.sync)) return errorResponse(400, 'bad_request', `profiles.improve.${name}.sync must be an object`, {}, requestId);
        const sync = entry.sync as Rec;
        if ('enabled' in sync) { const r = expectBool(sync.enabled, `profiles.improve.${name}.sync.enabled`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
        if ('push' in sync) { const r = expectBool(sync.push, `profiles.improve.${name}.sync.push`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
        if ('message' in sync) { const r = expectStr(sync.message, `profiles.improve.${name}.sync.message`); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
      }
    }
  }

  // ── defaults ──────────────────────────────────────────────────────────────
  const defaultsBody = body.defaults as Rec | undefined;
  if (defaultsBody !== undefined && !isRec(defaultsBody))
    return errorResponse(400, 'bad_request', 'defaults must be an object', {}, requestId);
  if (defaultsBody?.llm !== undefined) { const r = expectStr(defaultsBody.llm, 'defaults.llm'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
  if (defaultsBody?.agent !== undefined) { const r = expectStr(defaultsBody.agent, 'defaults.agent'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
  // defaults.improve is a string profile name (0.8.0 schema)
  if (defaultsBody?.improve !== undefined) { const r = expectStr(defaultsBody.improve, 'defaults.improve'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }

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
  // NOTE: stashDir is NOT operator-editable — the assistant's primary stash is
  // always /stash (the bind mount). Any body.stashDir is ignored and the value is
  // pinned below.

  // ── output ────────────────────────────────────────────────────────────────
  const outputBody = body.output as Rec | undefined;
  if (outputBody !== undefined) {
    if (!isRec(outputBody)) return errorResponse(400, 'bad_request', 'output must be an object', {}, requestId);
    if ('format' in outputBody && (typeof outputBody.format !== 'string' || !OUTPUT_FORMATS.has(outputBody.format as string)))
      return errorResponse(400, 'bad_request', 'output.format must be json, yaml, or text', {}, requestId);
    if ('detail' in outputBody && (typeof outputBody.detail !== 'string' || !OUTPUT_DETAILS.has(outputBody.detail as string)))
      return errorResponse(400, 'bad_request', 'output.detail must be brief, normal, or full', {}, requestId);
  }

  // ── Advanced: top-level improve / search / feedback / index ────────────────
  const improveTopBody = body.improve as Rec | undefined;
  if (improveTopBody !== undefined) {
    if (!isRec(improveTopBody)) return errorResponse(400, 'bad_request', 'improve must be an object', {}, requestId);
    if ('utilityDecay' in improveTopBody) {
      if (!isRec(improveTopBody.utilityDecay)) return errorResponse(400, 'bad_request', 'improve.utilityDecay must be an object', {}, requestId);
      const d = improveTopBody.utilityDecay as Rec;
      if ('halfLifeDays' in d && (typeof d.halfLifeDays !== 'number' || d.halfLifeDays < 0.1)) return errorResponse(400, 'bad_request', 'improve.utilityDecay.halfLifeDays must be a number ≥ 0.1', {}, requestId);
      if ('feedbackStabilityBoost' in d && (typeof d.feedbackStabilityBoost !== 'number' || d.feedbackStabilityBoost < 1)) return errorResponse(400, 'bad_request', 'improve.utilityDecay.feedbackStabilityBoost must be a number ≥ 1', {}, requestId);
    }
    if ('eventRetentionDays' in improveTopBody && (typeof improveTopBody.eventRetentionDays !== 'number' || improveTopBody.eventRetentionDays < 0))
      return errorResponse(400, 'bad_request', 'improve.eventRetentionDays must be a non-negative number', {}, requestId);
  }
  const searchBody = body.search as Rec | undefined;
  if (searchBody !== undefined) {
    if (!isRec(searchBody)) return errorResponse(400, 'bad_request', 'search must be an object', {}, requestId);
    if ('minScore' in searchBody && (typeof searchBody.minScore !== 'number' || searchBody.minScore < 0)) return errorResponse(400, 'bad_request', 'search.minScore must be a non-negative number', {}, requestId);
    if ('curateRerank' in searchBody) { const r = validateEnabledGate(searchBody.curateRerank, 'search.curateRerank'); if (r) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
  }
  const feedbackBody = body.feedback as Rec | undefined;
  if (feedbackBody !== undefined) {
    if (!isRec(feedbackBody)) return errorResponse(400, 'bad_request', 'feedback must be an object', {}, requestId);
    if ('requireReason' in feedbackBody) { const r = expectBool(feedbackBody.requireReason, 'feedback.requireReason'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
    if ('allowedFailureModes' in feedbackBody && (!Array.isArray(feedbackBody.allowedFailureModes) || !feedbackBody.allowedFailureModes.every((m) => typeof m === 'string' && m.length > 0)))
      return errorResponse(400, 'bad_request', 'feedback.allowedFailureModes must be an array of non-empty strings', {}, requestId);
  }
  const indexBody = body.index;
  if (indexBody !== undefined && !isRec(indexBody))
    return errorResponse(400, 'bad_request', 'index must be an object keyed by pass name', {}, requestId);

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

      if (profilesImproveBody !== undefined) {
        const existingImprove = (existingProfiles.improve as Rec) ?? {};
        const builtImprove: Rec = {};
        for (const [name, entry] of Object.entries(profilesImproveBody)) {
          const raw = entry as Rec;
          const existingProfile = (existingImprove[name] as Rec) ?? {};
          const profileEntry: Rec = { ...existingProfile };
          if ('description' in raw && raw.description) profileEntry.description = raw.description;
          if ('limit' in raw) profileEntry.limit = raw.limit;
          if ('autoAccept' in raw) profileEntry.autoAccept = raw.autoAccept;
          if ('processes' in raw && isRec(raw.processes)) {
            // The UI sends the COMPLETE intended process config (it round-trips any
            // fields it doesn't model via a passthrough), so replace each process
            // wholesale rather than field-merge — avoids stale fields lingering.
            const existingProcs = (existingProfile.processes as Rec) ?? {};
            const newProcs: Rec = { ...existingProcs };
            for (const [procName, proc] of Object.entries(raw.processes as Rec)) {
              newProcs[procName] = proc;
            }
            profileEntry.processes = newProcs;
          }
          // sync block (akm ImproveProfileConfigSchema.sync)
          if ('sync' in raw) {
            if (isRec(raw.sync)) profileEntry.sync = raw.sync;
            else delete profileEntry.sync;
          }
          builtImprove[name] = profileEntry;
        }
        newProfiles.improve = builtImprove;
      }

      updated.profiles = newProfiles;
    }

    // defaults — defaults.improve is a string (profile name)
    if (defaultsBody !== undefined) {
      const existingDefaults = (existing.defaults as Rec) ?? {};
      updated.defaults = {
        ...existingDefaults,
        ...('llm' in defaultsBody ? { llm: defaultsBody.llm } : {}),
        ...('agent' in defaultsBody ? { agent: defaultsBody.agent } : {}),
        ...('improve' in defaultsBody ? { improve: defaultsBody.improve } : {}),
      };
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
        merged.ollamaOptions = { ...(existing.embedding as Rec | undefined)?.ollamaOptions as Rec ?? {}, num_ctx: (embBody.ollamaOptions as Rec).num_ctx };
      }
      updated.embedding = merged;
    }

    // scalars
    if ('semanticSearchMode' in body) updated.semanticSearchMode = body.semanticSearchMode;
    // stashDir is pinned to the bind mount — never operator-editable.
    updated.stashDir = '/stash';

    // output
    if (outputBody !== undefined) {
      const existingOutput = (existing.output as Rec) ?? {};
      updated.output = {
        ...existingOutput,
        ...('format' in outputBody ? { format: outputBody.format } : {}),
        ...('detail' in outputBody ? { detail: outputBody.detail } : {}),
      };
    }

    // advanced top-level sections — the UI sends the complete intended object for
    // each (only configured fields), so replace wholesale; an empty/omitted body
    // for a section is left untouched (preserved via the `existing` spread).
    if (improveTopBody !== undefined) updated.improve = improveTopBody;
    if (searchBody !== undefined) updated.search = searchBody;
    if (feedbackBody !== undefined) updated.feedback = feedbackBody;
    if (indexBody !== undefined) updated.index = indexBody;

    mkdirSync(`${state.configDir}/akm`, { recursive: true });
    // I-5: atomic write through the shared lib writer (tmp+rename) so a
    // concurrent reader/akm process never observes a half-written config.
    writeFileAtomic(akmConfigPath(state.configDir), JSON.stringify(updated, null, 2), 0o600);

    return jsonResponse(200, { ok: true, config: updated }, requestId);
  } catch (e) {
    return errorResponse(500, 'internal_error', `Failed to persist akm config: ${String(e)}`, {}, requestId);
  }
};
