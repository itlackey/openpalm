/**
 * GET  /api/assistant/akm  — Return current akm config from OP_HOME/config/akm/config.json
 * PATCH /api/assistant/akm — Update config fields aligned with the AKM 0.9.0 schema
 *
 * Assistant-SCOPED AKM configuration: config/akm/config.json holds the assistant's AKM settings.
 * Assistant settings are a BASE capability (every process), so the browser can
 * read/write this config regardless of admin capability; guarded by the
 * assistant-settings capabilities in addition to requireAdmin.
 * Host-LEVEL AKM (host key sharing) stays at /api/host/akm/host-sharing.
 *
 * akm 0.9 hard break: `profiles.{llm,agent,improve}` became `engines.<name>`
 * (kind "llm" | "agent") and `improve.strategies.<name>`; `defaults.llm/agent/
 * improve` became `defaults.llmEngine/engine/improveStrategy`; the stash pin
 * moved from `stashDir` to `bundles.openpalm` + `defaultBundle`. Every PATCH
 * writes `configVersion: "0.9.0"` and strips the retired 0.8 keys (akm refuses
 * to load a config carrying them), so a pre-upgrade config is cleaned on the
 * first save.
 */
import type { RequestHandler } from './$types';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { writeFileAtomic } from '@openpalm/lib';
import { PRIMARY_BUNDLE_ID, stripRetiredAkmKeys } from '@openpalm/lib/control-plane/setup.js';
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

// akm 0.9 engine names: lowercase kebab, no reserved akm- prefix, ≤ 63 chars.
const ENGINE_NAME_RE = /^(?!akm-)[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
// apiKey must be a symbolic env reference ($VAR / ${VAR}) — akm 0.9 rejects raw keys.
const SYMBOLIC_KEY_RE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;

function validateLlmEngine(raw: Rec, prefix: string): Error | null {
  if ('endpoint' in raw) { const r = expectStr(raw.endpoint, `${prefix}.endpoint`); if (r instanceof Error) return r; }
  if ('model' in raw) { const r = expectStr(raw.model, `${prefix}.model`); if (r instanceof Error) return r; }
  if ('provider' in raw) { const r = expectStr(raw.provider, `${prefix}.provider`); if (r instanceof Error) return r; }
  if ('apiKey' in raw) {
    const r = expectStr(raw.apiKey, `${prefix}.apiKey`); if (r instanceof Error) return r;
    if (raw.apiKey && !SYMBOLIC_KEY_RE.test(raw.apiKey as string))
      return new Error(`${prefix}.apiKey must be a symbolic env reference like \${AKM_LLM_API_KEY}`);
  }
  if ('temperature' in raw) { const r = expectNum(raw.temperature, `${prefix}.temperature`, 0, 2); if (r instanceof Error) return r; }
  if ('maxTokens' in raw) { const r = expectPosInt(raw.maxTokens, `${prefix}.maxTokens`); if (r instanceof Error) return r; }
  if ('timeoutMs' in raw) { const r = expectPosInt(raw.timeoutMs, `${prefix}.timeoutMs`); if (r instanceof Error) return r; }
  if ('concurrency' in raw) { const r = expectPosInt(raw.concurrency, `${prefix}.concurrency`); if (r instanceof Error) return r; }
  if ('contextLength' in raw) { const r = expectPosInt(raw.contextLength, `${prefix}.contextLength`); if (r instanceof Error) return r; }
  if ('supportsJsonSchema' in raw) { const r = expectBool(raw.supportsJsonSchema, `${prefix}.supportsJsonSchema`); if (r instanceof Error) return r; }
  if ('enableThinking' in raw) { const r = expectBool(raw.enableThinking, `${prefix}.enableThinking`); if (r instanceof Error) return r; }
  if ('extraParams' in raw && !isRec(raw.extraParams)) return new Error(`${prefix}.extraParams must be an object`);
  return null;
}

function pickLlmEngine(raw: Rec): Rec {
  const out: Rec = { kind: 'llm' };
  const strFields = ['endpoint','model','provider'] as const;
  for (const f of strFields) if (f in raw && raw[f]) out[f] = raw[f];
  if ('apiKey' in raw) { if (raw.apiKey) out.apiKey = raw.apiKey; }
  const numFields = ['temperature','maxTokens','timeoutMs','concurrency','contextLength'] as const;
  for (const f of numFields) if (f in raw && raw[f] !== undefined) out[f] = raw[f];
  if ('supportsJsonSchema' in raw) out.supportsJsonSchema = raw.supportsJsonSchema;
  if ('enableThinking' in raw) out.enableThinking = raw.enableThinking;
  if (isRec(raw.extraParams) && Object.keys(raw.extraParams as Rec).length) out.extraParams = raw.extraParams;
  return out;
}

const ENGINE_KINDS = new Set(['llm','agent']);
const AGENT_PLATFORMS = new Set(['opencode','claude','opencode-sdk','codex','copilot','pi','gemini','aider','amazonq','openhands']);
// Process names per akm 0.9 improve strategy schema.
const ALLOWED_IMPROVE_PROCESSES = new Set(['reflect','distill','consolidate','memoryInference','graphExtraction','validation','extract','triage','triagePromote','memoryCleanup','akmExtract']);
const APPLY_MODES = new Set(['queue','promote']);
const SEMANTIC_SEARCH_MODES = new Set(['auto','off']);
const OUTPUT_FORMATS = new Set(['json','yaml','text']);
const OUTPUT_DETAILS = new Set(['brief','normal','full']);

// Retired 0.8 keys — akm 0.9 refuses to load a config carrying them, so PATCH
// strips them from the merged output (and never accepts them as input) via
// lib's stripRetiredAkmKeys (RETIRED_AKM_CONFIG_KEYS + defaults.llm/agent/improve).

function validateAgentEngine(raw: Rec, prefix: string): Error | null {
  if ('platform' in raw && (typeof raw.platform !== 'string' || !AGENT_PLATFORMS.has(raw.platform as string)))
    return new Error(`${prefix}.platform must be one of: ${[...AGENT_PLATFORMS].join(', ')}`);
  if ('bin' in raw) { const r = expectStr(raw.bin, `${prefix}.bin`); if (r instanceof Error) return r; }
  if ('workspace' in raw) { const r = expectStr(raw.workspace, `${prefix}.workspace`); if (r instanceof Error) return r; }
  if ('model' in raw) { const r = expectStr(raw.model, `${prefix}.model`); if (r instanceof Error) return r; }
  if ('args' in raw && !Array.isArray(raw.args)) return new Error(`${prefix}.args must be an array`);
  if ('timeoutMs' in raw) { const r = expectPosInt(raw.timeoutMs, `${prefix}.timeoutMs`); if (r instanceof Error) return r; }
  if ('modelAliases' in raw && !isRec(raw.modelAliases)) return new Error(`${prefix}.modelAliases must be an object`);
  if ('llmEngine' in raw) {
    const r = expectStr(raw.llmEngine, `${prefix}.llmEngine`); if (r instanceof Error) return r;
    if (raw.platform !== 'opencode-sdk')
      return new Error(`${prefix}.llmEngine is only valid when platform is "opencode-sdk"`);
  }
  return null;
}

function pickAgentEngine(raw: Rec): Rec {
  const out: Rec = { kind: 'agent' };
  if ('platform' in raw) out.platform = raw.platform;
  if ('bin' in raw && raw.bin) out.bin = raw.bin;
  if ('args' in raw && Array.isArray(raw.args) && (raw.args as unknown[]).length) out.args = raw.args;
  if ('workspace' in raw && raw.workspace) out.workspace = raw.workspace;
  if ('model' in raw && raw.model) out.model = raw.model;
  if ('timeoutMs' in raw && raw.timeoutMs !== undefined) out.timeoutMs = raw.timeoutMs;
  if (isRec(raw.modelAliases) && Object.keys(raw.modelAliases as Rec).length) out.modelAliases = raw.modelAliases;
  if ('llmEngine' in raw && raw.llmEngine) out.llmEngine = raw.llmEngine;
  return out;
}

function validateEnabledGate(v: unknown, path: string): Error | null {
  if (!isRec(v)) return new Error(`${path} must be an object`);
  if ('enabled' in v) { const r = expectBool(v.enabled, `${path}.enabled`); if (r instanceof Error) return r; }
  return null;
}

function validateImproveProcess(proc: Rec, path: string): Error | null {
  if ('enabled' in proc) { const r = expectBool(proc.enabled, `${path}.enabled`); if (r instanceof Error) return r; }
  // akm 0.9: a single engine name replaces the 0.8 mode+profile pair.
  if ('mode' in proc || 'profile' in proc)
    return new Error(`${path} uses the retired mode/profile pair — akm 0.9 uses "engine" instead`);
  if ('engine' in proc) { const r = expectStr(proc.engine, `${path}.engine`); if (r instanceof Error) return r; }
  if ('model' in proc) { const r = expectStr(proc.model, `${path}.model`); if (r instanceof Error) return r; }
  if ('timeoutMs' in proc && proc.timeoutMs !== null) { const r = expectPosInt(proc.timeoutMs, `${path}.timeoutMs`); if (r instanceof Error) return r; }
  if ('llm' in proc && !isRec(proc.llm)) return new Error(`${path}.llm must be an object`);
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
    if ('mode' in j || 'profile' in j)
      return new Error(`${path}.judgment uses the retired mode/profile pair — akm 0.9 uses "engine" instead`);
    if ('engine' in j) { const r = expectStr(j.engine, `${path}.judgment.engine`); if (r instanceof Error) return r; }
    if ('timeoutMs' in j && j.timeoutMs !== null) { const r = expectPosInt(j.timeoutMs, `${path}.judgment.timeoutMs`); if (r instanceof Error) return r; }
  }
  return null;
}

function validateImproveStrategy(entry: Rec, prefix: string): Error | null {
  if ('description' in entry) { const r = expectStr(entry.description, `${prefix}.description`); if (r instanceof Error) return r; }
  if ('limit' in entry) { const r = expectPosInt(entry.limit, `${prefix}.limit`); if (r instanceof Error) return r; }
  // akm 0.9: proposals always queue — autoAccept was removed.
  if ('autoAccept' in entry) return new Error(`${prefix}.autoAccept was removed in akm 0.9 (proposals always queue)`);
  if ('engine' in entry) { const r = expectStr(entry.engine, `${prefix}.engine`); if (r instanceof Error) return r; }
  if ('model' in entry) { const r = expectStr(entry.model, `${prefix}.model`); if (r instanceof Error) return r; }
  if ('timeoutMs' in entry) { const r = expectPosInt(entry.timeoutMs, `${prefix}.timeoutMs`); if (r instanceof Error) return r; }
  if ('llm' in entry && !isRec(entry.llm)) return new Error(`${prefix}.llm must be an object`);
  if ('processes' in entry) {
    if (!isRec(entry.processes)) return new Error(`${prefix}.processes must be an object`);
    for (const [procName, proc] of Object.entries(entry.processes as Rec)) {
      if (!ALLOWED_IMPROVE_PROCESSES.has(procName))
        return new Error(`${prefix}.processes.${procName} is not a recognized process name`);
      if (!isRec(proc)) return new Error(`${prefix}.processes.${procName} must be an object`);
      const err = validateImproveProcess(proc as Rec, `${prefix}.processes.${procName}`);
      if (err) return err;
    }
  }
  if ('sync' in entry) {
    if (!isRec(entry.sync)) return new Error(`${prefix}.sync must be an object`);
    const sync = entry.sync as Rec;
    if ('enabled' in sync) { const r = expectBool(sync.enabled, `${prefix}.sync.enabled`); if (r instanceof Error) return r; }
    if ('push' in sync) { const r = expectBool(sync.push, `${prefix}.sync.push`); if (r instanceof Error) return r; }
    if ('message' in sync) { const r = expectStr(sync.message, `${prefix}.sync.message`); if (r instanceof Error) return r; }
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

  // ── engines (one map, partitioned by kind) ────────────────────────────────
  const enginesBody = body.engines as Rec | undefined;
  if (enginesBody !== undefined) {
    if (!isRec(enginesBody)) return errorResponse(400, 'bad_request', 'engines must be an object', {}, requestId);
    for (const [name, entry] of Object.entries(enginesBody)) {
      if (!ENGINE_NAME_RE.test(name) || name.length > 63)
        return errorResponse(400, 'bad_request', `engines.${name}: engine names must be lowercase kebab-case (not starting with "akm-", max 63 chars)`, {}, requestId);
      if (!isRec(entry)) return errorResponse(400, 'bad_request', `engines.${name} must be an object`, {}, requestId);
      if (typeof entry.kind !== 'string' || !ENGINE_KINDS.has(entry.kind))
        return errorResponse(400, 'bad_request', `engines.${name}.kind must be "llm" or "agent"`, {}, requestId);
      const err = entry.kind === 'llm'
        ? validateLlmEngine(entry, `engines.${name}`)
        : validateAgentEngine(entry, `engines.${name}`);
      if (err) return errorResponse(400, 'bad_request', err.message, {}, requestId);
    }
  }

  // ── defaults ──────────────────────────────────────────────────────────────
  const defaultsBody = body.defaults as Rec | undefined;
  if (defaultsBody !== undefined && !isRec(defaultsBody))
    return errorResponse(400, 'bad_request', 'defaults must be an object', {}, requestId);
  if (defaultsBody?.llmEngine !== undefined) { const r = expectStr(defaultsBody.llmEngine, 'defaults.llmEngine'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
  if (defaultsBody?.engine !== undefined) { const r = expectStr(defaultsBody.engine, 'defaults.engine'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }
  if (defaultsBody?.improveStrategy !== undefined) { const r = expectStr(defaultsBody.improveStrategy, 'defaults.improveStrategy'); if (r instanceof Error) return errorResponse(400, 'bad_request', r.message, {}, requestId); }

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
  // NOTE: the assistant's primary bundle is NOT operator-editable — it is
  // always the /stash bind mount, pinned below as bundles.openpalm +
  // defaultBundle. Any body.bundles / body.defaultBundle / body.stashDir is
  // ignored.

  // ── output ────────────────────────────────────────────────────────────────
  const outputBody = body.output as Rec | undefined;
  if (outputBody !== undefined) {
    if (!isRec(outputBody)) return errorResponse(400, 'bad_request', 'output must be an object', {}, requestId);
    if ('format' in outputBody && (typeof outputBody.format !== 'string' || !OUTPUT_FORMATS.has(outputBody.format as string)))
      return errorResponse(400, 'bad_request', 'output.format must be json, yaml, or text', {}, requestId);
    if ('detail' in outputBody && (typeof outputBody.detail !== 'string' || !OUTPUT_DETAILS.has(outputBody.detail as string)))
      return errorResponse(400, 'bad_request', 'output.detail must be brief, normal, or full', {}, requestId);
  }

  // ── improve (strategies + global tuning) / search / feedback / index ───────
  const improveBody = body.improve as Rec | undefined;
  const strategiesBody = improveBody !== undefined && isRec(improveBody) ? (improveBody.strategies as Rec | undefined) : undefined;
  if (improveBody !== undefined) {
    if (!isRec(improveBody)) return errorResponse(400, 'bad_request', 'improve must be an object', {}, requestId);
    if (strategiesBody !== undefined) {
      if (!isRec(strategiesBody)) return errorResponse(400, 'bad_request', 'improve.strategies must be an object', {}, requestId);
      for (const [name, entry] of Object.entries(strategiesBody)) {
        if (!isRec(entry)) return errorResponse(400, 'bad_request', `improve.strategies.${name} must be an object`, {}, requestId);
        const err = validateImproveStrategy(entry, `improve.strategies.${name}`);
        if (err) return errorResponse(400, 'bad_request', err.message, {}, requestId);
      }
    }
    if ('utilityDecay' in improveBody) {
      if (!isRec(improveBody.utilityDecay)) return errorResponse(400, 'bad_request', 'improve.utilityDecay must be an object', {}, requestId);
      const d = improveBody.utilityDecay as Rec;
      if ('halfLifeDays' in d && (typeof d.halfLifeDays !== 'number' || d.halfLifeDays < 0.1)) return errorResponse(400, 'bad_request', 'improve.utilityDecay.halfLifeDays must be a number ≥ 0.1', {}, requestId);
      if ('feedbackStabilityBoost' in d && (typeof d.feedbackStabilityBoost !== 'number' || d.feedbackStabilityBoost < 1)) return errorResponse(400, 'bad_request', 'improve.utilityDecay.feedbackStabilityBoost must be a number ≥ 1', {}, requestId);
    }
    if ('eventRetentionDays' in improveBody && (typeof improveBody.eventRetentionDays !== 'number' || improveBody.eventRetentionDays < 0))
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

    // engines — the UI sends the COMPLETE intended engines map (both kinds),
    // so the SET of engines is replaced wholesale, but each entry field-merges
    // over the existing engine of the same name (mirroring the improve-strategy
    // merge below): the pickers whitelist only UI-modeled fields, so a bare
    // replace would destroy unmodeled akm 0.9 fields (e.g. `capabilities`) on
    // every save, and a cleared endpoint would yield a bare {kind:'llm'} engine
    // akm's schema rejects — merging keeps the persisted value instead.
    if (enginesBody !== undefined) {
      const existingEngines = isRec(existing.engines) ? (existing.engines as Rec) : {};
      const built: Rec = {};
      for (const [name, entry] of Object.entries(enginesBody)) {
        const raw = entry as Rec;
        const picked = raw.kind === 'agent' ? pickAgentEngine(raw) : pickLlmEngine(raw);
        const prior = existingEngines[name];
        // Only merge over an existing entry of the SAME kind — a kind switch
        // must not drag llm fields onto an agent engine (or vice versa).
        built[name] = isRec(prior) && (prior as Rec).kind === picked.kind
          ? { ...(prior as Rec), ...picked }
          : picked;
      }
      updated.engines = built;
    }

    // defaults — string engine/strategy names
    if (defaultsBody !== undefined) {
      const existingDefaults = (existing.defaults as Rec) ?? {};
      updated.defaults = {
        ...existingDefaults,
        ...('llmEngine' in defaultsBody ? { llmEngine: defaultsBody.llmEngine } : {}),
        ...('engine' in defaultsBody ? { engine: defaultsBody.engine } : {}),
        ...('improveStrategy' in defaultsBody ? { improveStrategy: defaultsBody.improveStrategy } : {}),
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

    // output
    if (outputBody !== undefined) {
      const existingOutput = (existing.output as Rec) ?? {};
      updated.output = {
        ...existingOutput,
        ...('format' in outputBody ? { format: outputBody.format } : {}),
        ...('detail' in outputBody ? { detail: outputBody.detail } : {}),
      };
    }

    // improve — strategies get a per-strategy merge (so unmodeled strategy
    // fields survive a UI save); the global tuning knobs use the same
    // key-presence semantics as defaults/embedding/output above: keys absent
    // from the body are left untouched.
    if (improveBody !== undefined) {
      const existingImprove = (existing.improve as Rec) ?? {};
      const mergedImprove: Rec = { ...existingImprove };
      if (strategiesBody !== undefined) {
        const existingStrategies = (existingImprove.strategies as Rec) ?? {};
        const builtStrategies: Rec = {};
        for (const [name, entry] of Object.entries(strategiesBody)) {
          const raw = entry as Rec;
          const existingStrategy = (existingStrategies[name] as Rec) ?? {};
          const strategyEntry: Rec = { ...existingStrategy };
          delete strategyEntry.autoAccept; // retired in 0.9 — clean pre-upgrade leftovers
          if ('description' in raw && raw.description) strategyEntry.description = raw.description;
          if ('limit' in raw) strategyEntry.limit = raw.limit;
          if ('engine' in raw) strategyEntry.engine = raw.engine;
          if ('model' in raw) strategyEntry.model = raw.model;
          if ('timeoutMs' in raw) strategyEntry.timeoutMs = raw.timeoutMs;
          if ('llm' in raw && isRec(raw.llm)) strategyEntry.llm = raw.llm;
          if ('processes' in raw && isRec(raw.processes)) {
            // The UI sends the COMPLETE intended process config (it round-trips any
            // fields it doesn't model via a passthrough), so replace each process
            // wholesale rather than field-merge — avoids stale fields lingering.
            const existingProcs = (existingStrategy.processes as Rec) ?? {};
            const newProcs: Rec = { ...existingProcs };
            for (const [procName, proc] of Object.entries(raw.processes as Rec)) {
              newProcs[procName] = proc;
            }
            strategyEntry.processes = newProcs;
          }
          // sync block (per-strategy git sync)
          if ('sync' in raw) {
            if (isRec(raw.sync)) strategyEntry.sync = raw.sync;
            else delete strategyEntry.sync;
          }
          builtStrategies[name] = strategyEntry;
        }
        mergedImprove.strategies = builtStrategies;
      }
      if ('utilityDecay' in improveBody) mergedImprove.utilityDecay = improveBody.utilityDecay;
      if ('eventRetentionDays' in improveBody) mergedImprove.eventRetentionDays = improveBody.eventRetentionDays;
      updated.improve = mergedImprove;
    }

    // advanced top-level sections — the UI sends the complete intended object for
    // each (only configured fields), so replace wholesale; an empty/omitted body
    // for a section is left untouched (preserved via the `existing` spread).
    if (searchBody !== undefined) updated.search = searchBody;
    if (feedbackBody !== undefined) updated.feedback = feedbackBody;
    if (indexBody !== undefined) updated.index = indexBody;

    // ── akm 0.9 invariants ───────────────────────────────────────────────────
    // Strip every retired 0.8 key from the merged output — akm refuses to load
    // a config that carries them, so a pre-upgrade config is cleaned on the
    // first PATCH.
    stripRetiredAkmKeys(updated);
    // The config version is always the 0.9.0 schema this endpoint writes.
    updated.configVersion = '0.9.0';
    // The assistant's primary bundle is pinned to the /stash bind mount —
    // never operator-editable (body.bundles/defaultBundle are ignored above).
    const existingBundles = isRec(existing.bundles) ? (existing.bundles as Rec) : {};
    updated.bundles = { ...existingBundles, [PRIMARY_BUNDLE_ID]: { path: '/stash', writable: true } };
    if (typeof existing.defaultBundle === 'string') updated.defaultBundle = existing.defaultBundle;
    else updated.defaultBundle = PRIMARY_BUNDLE_ID;

    mkdirSync(`${state.configDir}/akm`, { recursive: true });
    // I-5: atomic write through the shared lib writer (tmp+rename) so a
    // concurrent reader/akm process never observes a half-written config.
    writeFileAtomic(akmConfigPath(state.configDir), JSON.stringify(updated, null, 2), 0o600);

    return jsonResponse(200, { ok: true, config: updated }, requestId);
  } catch (e) {
    return errorResponse(500, 'internal_error', `Failed to persist akm config: ${String(e)}`, {}, requestId);
  }
};
