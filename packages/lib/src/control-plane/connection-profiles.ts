/**
 * Connection profile CRUD operations — backed by stack.yaml.
 *
 * Replaces the old profiles.json approach. All connection and assignment
 * data now lives in stack.yaml as the single source of truth.
 */
import type {
  CapabilityAssignments,
  CanonicalConnectionProfile,
  CanonicalConnectionsDocument,
  ConnectionKind,
} from './types.js';
import { readStackSpec, writeStackSpec, type StackSpec, type StackSpecConnection } from './stack-spec.js';

const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'model-runner']);
const INSTACK_PROVIDERS = new Set(['ollama-instack']);

function normalizeConnectionKind(provider: string): ConnectionKind {
  if (INSTACK_PROVIDERS.has(provider)) return 'ollama_local';
  if (LOCAL_PROVIDERS.has(provider)) return 'openai_compatible_local';
  return 'openai_compatible_remote';
}

// ── Conversion helpers ──────────────────────────────────────────────────

function specConnectionToProfile(conn: StackSpecConnection): CanonicalConnectionProfile {
  return {
    id: conn.id,
    name: conn.name,
    kind: (conn.kind === 'ollama_stack' ? 'ollama_local' : conn.kind) as ConnectionKind,
    provider: conn.provider,
    baseUrl: conn.baseUrl,
    auth: conn.auth.mode === 'api_key'
      ? { mode: 'api_key' as const, apiKeySecretRef: conn.auth.apiKeySecretRef ?? '' }
      : { mode: 'none' as const },
  };
}

function profileToSpecConnection(profile: CanonicalConnectionProfile): StackSpecConnection {
  return {
    id: profile.id,
    name: profile.name,
    kind: normalizeConnectionKind(profile.provider) as StackSpecConnection['kind'],
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    auth: profile.auth.mode === 'api_key'
      ? { mode: 'api_key' as const, apiKeySecretRef: profile.auth.apiKeySecretRef }
      : { mode: 'none' as const },
  };
}

function specToAssignments(spec: StackSpec): CapabilityAssignments {
  return {
    llm: { connectionId: spec.assignments.llm.connectionId, model: spec.assignments.llm.model },
    embeddings: {
      connectionId: spec.assignments.embeddings.connectionId,
      model: spec.assignments.embeddings.model,
      embeddingDims: spec.assignments.embeddings.embeddingDims,
    },
    reranking: spec.assignments.reranking ? {
      enabled: spec.assignments.reranking.enabled,
      connectionId: spec.assignments.reranking.connectionId,
      mode: spec.assignments.reranking.mode,
      model: spec.assignments.reranking.model,
      topK: spec.assignments.reranking.topK,
      topN: spec.assignments.reranking.topN,
    } : undefined,
    tts: spec.assignments.tts ? {
      enabled: spec.assignments.tts.enabled,
      connectionId: spec.assignments.tts.connectionId,
      model: spec.assignments.tts.model,
      voice: spec.assignments.tts.voice,
      format: spec.assignments.tts.format,
    } : undefined,
    stt: spec.assignments.stt ? {
      enabled: spec.assignments.stt.enabled,
      connectionId: spec.assignments.stt.connectionId,
      model: spec.assignments.stt.model,
      language: spec.assignments.stt.language,
    } : undefined,
  };
}

// ── Validation helpers ──────────────────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// ── Read / Write ────────────────────────────────────────────────────────

function readOrDefaultSpec(configDir: string): StackSpec {
  const spec = readStackSpec(configDir);
  if (spec) return spec;
  return {
    version: 1,
    connections: [],
    assignments: {
      llm: { connectionId: '', model: '' },
      embeddings: { connectionId: '', model: '', embeddingDims: undefined },
      memory: {
        llm: { connectionId: '', model: '' },
        embeddings: { connectionId: '', model: '' },
        vectorStore: { provider: 'sqlite-vec', collectionName: 'memory', dbPath: '/data/memory.db' },
      },
    },
    addons: [],
  };
}

export function readConnectionProfilesDocument(configDir: string): CanonicalConnectionsDocument {
  const spec = readOrDefaultSpec(configDir);
  return {
    version: 1,
    profiles: spec.connections.map(specConnectionToProfile),
    assignments: specToAssignments(spec),
  };
}

export function writeConnectionProfilesDocument(
  configDir: string,
  document: CanonicalConnectionsDocument
): void {
  const spec = readOrDefaultSpec(configDir);
  spec.connections = document.profiles.map(profileToSpecConnection);
  // Update assignments from document
  spec.assignments.llm = { connectionId: document.assignments.llm.connectionId, model: document.assignments.llm.model };
  spec.assignments.embeddings = {
    connectionId: document.assignments.embeddings.connectionId,
    model: document.assignments.embeddings.model,
    embeddingDims: document.assignments.embeddings.embeddingDims,
  };
  // Unconditionally update optional assignments — undefined clears them
  spec.assignments.reranking = document.assignments.reranking;
  spec.assignments.tts = document.assignments.tts;
  spec.assignments.stt = document.assignments.stt;
  writeStackSpec(configDir, spec);
}

export type WriteConnectionsInput = {
  profiles: Array<{
    id: string;
    name: string;
    provider: string;
    baseUrl: string;
    hasApiKey: boolean;
    apiKeyEnvVar: string;
  }>;
  assignments: CapabilityAssignments;
};

export function writeConnectionsDocument(
  configDir: string,
  input: WriteConnectionsInput
): CanonicalConnectionsDocument {
  if (input.profiles.length === 0) {
    throw new Error('writeConnectionsDocument: profiles must not be empty');
  }

  const profileIds = new Set(input.profiles.map((p) => p.id));
  if (!profileIds.has(input.assignments.llm.connectionId)) {
    throw new Error(`writeConnectionsDocument: llm.connectionId "${input.assignments.llm.connectionId}" not found in profiles`);
  }
  if (!profileIds.has(input.assignments.embeddings.connectionId)) {
    throw new Error(`writeConnectionsDocument: embeddings.connectionId "${input.assignments.embeddings.connectionId}" not found in profiles`);
  }

  const document: CanonicalConnectionsDocument = {
    version: 1,
    profiles: input.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      kind: normalizeConnectionKind(p.provider),
      provider: p.provider,
      baseUrl: p.baseUrl,
      auth: {
        mode: p.hasApiKey ? 'api_key' as const : 'none' as const,
        ...(p.hasApiKey ? { apiKeySecretRef: `env:${p.apiKeyEnvVar}` } : {}),
      },
    })),
    assignments: input.assignments,
  };

  writeConnectionProfilesDocument(configDir, document);
  return document;
}

// ── CRUD operations ─────────────────────────────────────────────────────

type MutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409; message: string };

function validateProfile(profile: CanonicalConnectionProfile): MutationResult<CanonicalConnectionProfile> {
  if (!profile.id.trim()) {
    return { ok: false, status: 400, message: 'profile.id is required' };
  }
  if (!profile.name.trim()) {
    return { ok: false, status: 400, message: 'profile.name is required' };
  }
  if (!profile.provider.trim()) {
    return { ok: false, status: 400, message: 'profile.provider is required' };
  }
  if (profile.auth.mode !== 'api_key' && profile.auth.mode !== 'none') {
    return { ok: false, status: 400, message: 'profile.auth.mode must be api_key or none' };
  }
  if (profile.auth.mode === 'api_key' && !profile.auth.apiKeySecretRef?.trim()) {
    return { ok: false, status: 400, message: 'profile.auth.apiKeySecretRef is required when auth.mode is api_key' };
  }
  return { ok: true, value: profile };
}

function validateAssignments(
  assignments: CapabilityAssignments,
  profileIds: Set<string>
): MutationResult<CapabilityAssignments> {
  if (!isNonEmptyString(assignments.llm.connectionId) || !isNonEmptyString(assignments.llm.model)) {
    return { ok: false, status: 400, message: 'assignments.llm requires connectionId and model' };
  }
  if (!isNonEmptyString(assignments.embeddings.connectionId) || !isNonEmptyString(assignments.embeddings.model)) {
    return { ok: false, status: 400, message: 'assignments.embeddings requires connectionId and model' };
  }
  if (!profileIds.has(assignments.llm.connectionId)) {
    return { ok: false, status: 409, message: `assignments.llm.connectionId not found: ${assignments.llm.connectionId}` };
  }
  if (!profileIds.has(assignments.embeddings.connectionId)) {
    return { ok: false, status: 409, message: `assignments.embeddings.connectionId not found: ${assignments.embeddings.connectionId}` };
  }
  if (
    assignments.embeddings.embeddingDims !== undefined
    && (!Number.isInteger(assignments.embeddings.embeddingDims) || assignments.embeddings.embeddingDims <= 0)
  ) {
    return { ok: false, status: 400, message: 'assignments.embeddings.embeddingDims must be a positive integer' };
  }
  return { ok: true, value: assignments };
}

export function listConnectionProfiles(configDir: string): CanonicalConnectionProfile[] {
  return readConnectionProfilesDocument(configDir).profiles;
}

export function getCapabilityAssignments(configDir: string): CapabilityAssignments {
  return readConnectionProfilesDocument(configDir).assignments;
}

export function createConnectionProfile(
  configDir: string,
  profile: CanonicalConnectionProfile
): MutationResult<CanonicalConnectionProfile> {
  const validated = validateProfile(profile);
  if (!validated.ok) return validated;

  const document = readConnectionProfilesDocument(configDir);
  if (document.profiles.some((existing) => existing.id === profile.id)) {
    return { ok: false, status: 409, message: `profile already exists: ${profile.id}` };
  }

  const updated: CanonicalConnectionsDocument = {
    ...document,
    profiles: [...document.profiles, profile],
  };
  writeConnectionProfilesDocument(configDir, updated);
  return { ok: true, value: profile };
}

export function updateConnectionProfile(
  configDir: string,
  profile: CanonicalConnectionProfile
): MutationResult<CanonicalConnectionProfile> {
  const validated = validateProfile(profile);
  if (!validated.ok) return validated;

  const document = readConnectionProfilesDocument(configDir);
  const index = document.profiles.findIndex((existing) => existing.id === profile.id);
  if (index < 0) {
    return { ok: false, status: 404, message: `profile not found: ${profile.id}` };
  }

  const profiles = [...document.profiles];
  profiles[index] = profile;
  writeConnectionProfilesDocument(configDir, { ...document, profiles });
  return { ok: true, value: profile };
}

export function deleteConnectionProfile(
  configDir: string,
  id: string
): MutationResult<{ id: string }> {
  if (!id.trim()) {
    return { ok: false, status: 400, message: 'profile id is required' };
  }

  const document = readConnectionProfilesDocument(configDir);
  const existing = document.profiles.find((profile) => profile.id === id);
  if (!existing) {
    return { ok: false, status: 404, message: `profile not found: ${id}` };
  }
  const assignmentFields = ['llm', 'embeddings', 'reranking', 'tts', 'stt'] as const;
  for (const field of assignmentFields) {
    const assignment = document.assignments[field];
    if (assignment && 'connectionId' in assignment && assignment.connectionId === id) {
      return { ok: false, status: 409, message: `Cannot delete profile: it is assigned to ${field}` };
    }
  }

  writeConnectionProfilesDocument(configDir, {
    ...document,
    profiles: document.profiles.filter((profile) => profile.id !== id),
  });
  return { ok: true, value: { id } };
}

export function saveCapabilityAssignments(
  configDir: string,
  assignments: CapabilityAssignments
): MutationResult<CapabilityAssignments> {
  const document = readConnectionProfilesDocument(configDir);
  const profileIds = new Set(document.profiles.map((profile) => profile.id));
  const validated = validateAssignments(assignments, profileIds);
  if (!validated.ok) return validated;

  writeConnectionProfilesDocument(configDir, {
    ...document,
    assignments,
  });
  return { ok: true, value: assignments };
}

// Legacy compat — these are no-ops now since stack.yaml is always the backing store
export function getConnectionProfilesDir(configDir: string): string {
  return configDir;
}

export function getConnectionProfilesPath(configDir: string): string {
  return `${configDir}/stack.yaml`;
}

export function ensureConnectionProfilesStore(_configDir: string): void {
  // No-op — stack.yaml is created by writeStackSpec
}
