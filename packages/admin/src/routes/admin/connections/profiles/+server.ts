import type { RequestHandler } from './$types';
import { PROVIDER_KEY_MAP } from '$lib/provider-constants.js';
import { getState } from '$lib/server/state.js';
import {
  appendAudit,
  createConnectionProfile,
  deleteConnectionProfile,
  listConnectionProfiles,
  patchSecretsEnvFile,
  updateConnectionProfile,
  type CanonicalConnectionProfile,
} from '$lib/server/control-plane.js';
import {
  errorResponse,
  getActor,
  getCallerType,
  getRequestId,
  jsonResponse,
  parseCanonicalConnectionProfile,
  parseJsonBody,
  requireAdmin,
} from '$lib/server/helpers.js';

type ProfileParseResult =
  | { ok: true; value: CanonicalConnectionProfile; secretPatch?: Record<string, string> }
  | { ok: false; status: number; message: string };

function normalizeProfilePayload(rawProfile: unknown): ProfileParseResult {
  if (typeof rawProfile !== 'object' || rawProfile === null) {
    return {
      ok: false,
      status: 400,
      message: 'connection profile must be an object',
    };
  }

  const record = rawProfile as Record<string, unknown>;
  const auth = typeof record.auth === 'object' && record.auth !== null
    ? record.auth as Record<string, unknown>
    : null;

  if (!auth || auth.mode !== 'api_key') {
    const parsed = parseCanonicalConnectionProfile(rawProfile);
    return parsed.ok
      ? parsed as ProfileParseResult
      : { ok: false, status: 400, message: parsed.message };
  }

  const rawApiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : '';
  const rawSecretRef = typeof auth.apiKeySecretRef === 'string' ? auth.apiKeySecretRef.trim() : '';

  if (!rawApiKey && !rawSecretRef) {
    return {
      ok: false,
      status: 400,
      message: 'connection profile auth apiKeySecretRef is required when mode is api_key',
    };
  }

  const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
  const secretEnvVar = rawSecretRef.startsWith('env:')
    ? rawSecretRef.slice(4)
    : PROVIDER_KEY_MAP[provider];

  if (!secretEnvVar) {
    return {
      ok: false,
      status: 400,
      message: `profile.auth.apiKeySecretRef is required when auth.mode is api_key for provider "${provider}"`,
    };
  }

  const canonicalProfile = {
    ...record,
    auth: {
      mode: 'api_key',
      apiKeySecretRef: `env:${secretEnvVar}`,
    },
  };

  const normalized = parseCanonicalConnectionProfile(canonicalProfile);
  if (!normalized.ok) {
    return { ok: false, status: 400, message: normalized.message };
  }

  return {
    ok: true,
    value: normalized.value,
    ...(rawApiKey ? { secretPatch: { [secretEnvVar]: rawApiKey } } : {}),
  };
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  let profiles: CanonicalConnectionProfile[];
  try {
    profiles = listConnectionProfiles(state.configDir);
  } catch {
    // No profiles.json yet — return empty list
    profiles = [];
  }
  appendAudit(state, getActor(event), 'connections.profiles.get', {}, true, requestId, getCallerType(event));
  return jsonResponse(200, { profiles }, requestId);
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
  const parsed = normalizeProfilePayload(body.profile);
  if (!parsed.ok) {
    return errorResponse(parsed.status, 'bad_request', parsed.message, {}, requestId);
  }

  const result = createConnectionProfile(state.configDir, parsed.value as CanonicalConnectionProfile);
  if (!result.ok) {
    return errorResponse(result.status, result.status === 409 ? 'conflict' : 'bad_request', result.message, {}, requestId);
  }
  if (parsed.secretPatch) {
    patchSecretsEnvFile(state.configDir, parsed.secretPatch);
  }

  appendAudit(state, actor, 'connections.profiles.create', { id: result.value.id }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, profile: result.value }, requestId);
};

export const PUT: RequestHandler = async (event) => {
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
  const parsed = normalizeProfilePayload(body.profile);
  if (!parsed.ok) {
    return errorResponse(parsed.status, 'bad_request', parsed.message, {}, requestId);
  }

  const result = updateConnectionProfile(state.configDir, parsed.value as CanonicalConnectionProfile);
  if (!result.ok) {
    return errorResponse(result.status, result.status === 404 ? 'not_found' : 'bad_request', result.message, {}, requestId);
  }
  if (parsed.secretPatch) {
    patchSecretsEnvFile(state.configDir, parsed.secretPatch);
  }

  appendAudit(state, actor, 'connections.profiles.update', { id: result.value.id }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, profile: result.value }, requestId);
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);
  if (!body || typeof body.id !== 'string') {
    return errorResponse(400, 'bad_request', 'profile id is required', {}, requestId);
  }

  const result = deleteConnectionProfile(state.configDir, body.id);
  if (!result.ok) {
    const errorCode = result.status === 404 ? 'not_found' : result.status === 409 ? 'conflict' : 'bad_request';
    return errorResponse(result.status, errorCode, result.message, {}, requestId);
  }

  appendAudit(state, actor, 'connections.profiles.delete', { id: result.value.id }, true, requestId, callerType);
  return jsonResponse(200, { ok: true, id: result.value.id }, requestId);
};
