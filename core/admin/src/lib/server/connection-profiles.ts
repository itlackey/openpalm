import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PROVIDER_KEY_MAP } from '../provider-constants.js';
import type {
  CapabilityAssignments,
  CanonicalConnectionProfile,
  CanonicalConnectionsDocument,
  ConnectionKind,
} from './types.js';

const CONNECTIONS_DIRNAME = 'connections';
const CONNECTION_PROFILES_FILENAME = 'profiles.json';

const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'model-runner']);

export function getConnectionProfilesDir(configDir: string): string {
  return `${configDir}/${CONNECTIONS_DIRNAME}`;
}

export function getConnectionProfilesPath(configDir: string): string {
  return `${getConnectionProfilesDir(configDir)}/${CONNECTION_PROFILES_FILENAME}`;
}

function normalizeConnectionKind(provider: string): ConnectionKind {
  return LOCAL_PROVIDERS.has(provider)
    ? 'openai_compatible_local'
    : 'openai_compatible_remote';
}

// ── Validation helpers ──────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidProfile(value: unknown): value is CanonicalConnectionProfile {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isNonEmptyString(value.name)) return false;
  if (value.kind !== 'openai_compatible_remote' && value.kind !== 'openai_compatible_local') return false;
  if (!isNonEmptyString(value.provider)) return false;
  if (typeof value.baseUrl !== 'string') return false;
  if (!isRecord(value.auth)) return false;
  if (value.auth.mode !== 'api_key' && value.auth.mode !== 'none') return false;
  if (value.auth.mode === 'api_key' && !isNonEmptyString(value.auth.apiKeySecretRef)) return false;
  return true;
}

function isValidConnectionDocument(value: unknown): value is CanonicalConnectionsDocument {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) return false;
  if (!isRecord(value.assignments)) return false;

  if (!value.profiles.every(isValidProfile)) return false;

  const llm = value.assignments.llm;
  const embeddings = value.assignments.embeddings;
  if (!isRecord(llm) || !isRecord(embeddings)) return false;
  if (!isNonEmptyString(llm.connectionId) || !isNonEmptyString(llm.model)) return false;
  if (!isNonEmptyString(embeddings.connectionId) || !isNonEmptyString(embeddings.model)) return false;
  const embeddingDims = embeddings.embeddingDims;
  if (
    embeddingDims !== undefined
    && (typeof embeddingDims !== 'number' || !Number.isInteger(embeddingDims) || embeddingDims <= 0)
  ) {
    return false;
  }

  return true;
}

// ── Read / Write ────────────────────────────────────────────────────────

export function writeConnectionProfilesDocument(
  configDir: string,
  document: CanonicalConnectionsDocument
): void {
  const dir = getConnectionProfilesDir(configDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    getConnectionProfilesPath(configDir),
    JSON.stringify(document, null, 2) + '\n'
  );
}

export function readConnectionProfilesDocument(configDir: string): CanonicalConnectionsDocument {
  const path = getConnectionProfilesPath(configDir);
  if (!existsSync(path)) {
    throw new Error('connections/profiles.json does not exist');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('connections/profiles.json is invalid JSON');
  }

  if (!isValidConnectionDocument(parsed)) {
    throw new Error('connections/profiles.json is invalid: expected CanonicalConnectionsDocument v1');
  }

  return parsed;
}

export function ensureConnectionProfilesStore(configDir: string): void {
  mkdirSync(getConnectionProfilesDir(configDir), { recursive: true });
}

// ── Multi-connection write ──────────────────────────────────────────────

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
  if (!isRecord(assignments.llm)) {
    return { ok: false, status: 400, message: 'assignments.llm must be an object' };
  }
  if (!isRecord(assignments.embeddings)) {
    return { ok: false, status: 400, message: 'assignments.embeddings must be an object' };
  }
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
  if (document.assignments.llm.connectionId === id || document.assignments.embeddings.connectionId === id) {
    return { ok: false, status: 409, message: `profile is in use by assignments: ${id}` };
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
