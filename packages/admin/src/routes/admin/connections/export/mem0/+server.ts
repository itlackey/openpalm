import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  requireAdminOrSetupToken,
} from '$lib/server/helpers.js';
import {
  readConnectionProfilesDocument,
  buildMem0MappingFromProfiles,
} from '$lib/server/control-plane.js';
import { EMBEDDING_DIMS } from '$lib/provider-constants.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdminOrSetupToken(event, requestId);
  if (authErr) return authErr;

  const state = getState();

  let doc;
  try {
    doc = readConnectionProfilesDocument(state.configDir);
  } catch {
    return errorResponse(404, 'not_found', 'No connection profiles found. Complete wizard setup first.', {}, requestId);
  }

  const { profiles, assignments } = doc;

  const llmProfile = profiles.find((p) => p.id === assignments.llm.connectionId);
  const embedProfile = profiles.find((p) => p.id === assignments.embeddings.connectionId);

  if (!llmProfile) {
    return errorResponse(409, 'conflict', `LLM connection profile not found: ${assignments.llm.connectionId}`, {}, requestId);
  }
  if (!embedProfile) {
    return errorResponse(409, 'conflict', `Embeddings connection profile not found: ${assignments.embeddings.connectionId}`, {}, requestId);
  }

  const lookupKey = `${embedProfile.provider}/${assignments.embeddings.model}`;
  const resolvedDims = assignments.embeddings.embeddingDims
    ?? EMBEDDING_DIMS[lookupKey]
    ?? 1536;

  const mapping = buildMem0MappingFromProfiles(
    llmProfile,
    embedProfile,
    assignments.llm.model,
    assignments.embeddings.model,
    resolvedDims,
    '',
  );

  return new Response(JSON.stringify(mapping, null, 2) + '\n', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="mem0-config.json"',
      'x-request-id': requestId,
    },
  });
};
