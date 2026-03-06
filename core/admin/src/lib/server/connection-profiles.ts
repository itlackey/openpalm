import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PROVIDER_KEY_MAP } from '../provider-constants.js';
import type {
  CapabilityAssignments,
  CanonicalConnectionProfile,
  CanonicalConnectionsDocument,
  ConnectionKind,
} from './types.js';
import { readSecretsEnvFile } from './secrets.js';

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

function hasApiKeyForProvider(provider: string, secrets: Record<string, string>): boolean {
  const envKey = PROVIDER_KEY_MAP[provider] ?? 'OPENAI_API_KEY';
  return Boolean(secrets[envKey]);
}

function buildLegacyDocumentFromSecrets(configDir: string): CanonicalConnectionsDocument {
  const secrets = readSecretsEnvFile(configDir);
  const provider = secrets.SYSTEM_LLM_PROVIDER || 'openai';
  const model = secrets.SYSTEM_LLM_MODEL || '';
  const embeddingModel = secrets.EMBEDDING_MODEL || '';
  const embeddingDims = Number(secrets.EMBEDDING_DIMS || '0');
  const apiKeyEnv = PROVIDER_KEY_MAP[provider] ?? 'OPENAI_API_KEY';
  const hasApiKey = hasApiKeyForProvider(provider, secrets);

  return {
    version: 1,
    profiles: [
      {
        id: 'primary',
        name: 'Primary connection',
        kind: normalizeConnectionKind(provider),
        provider,
        baseUrl: secrets.SYSTEM_LLM_BASE_URL || '',
        auth: {
          mode: hasApiKey ? 'api_key' : 'none',
          ...(hasApiKey ? { apiKeySecretRef: `env:${apiKeyEnv}` } : {}),
        },
      },
    ],
    assignments: {
      llm: {
        connectionId: 'primary',
        model,
      },
      embeddings: {
        connectionId: 'primary',
        model: embeddingModel,
        ...(Number.isInteger(embeddingDims) && embeddingDims > 0 ? { embeddingDims } : {}),
      },
    },
  };
}

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
  return readConnectionProfilesDocumentWithOptions(configDir, {
    preferLegacyRead: false,
    hydrateFromLegacy: false,
    onInvalid: 'throw',
  });
}

type ReadConnectionProfilesOptions = {
  preferLegacyRead?: boolean;
  hydrateFromLegacy?: boolean;
  onInvalid?: 'throw' | 'migrate';
};

export function readConnectionProfilesDocumentWithOptions(
  configDir: string,
  options: ReadConnectionProfilesOptions
): CanonicalConnectionsDocument {
  const path = getConnectionProfilesPath(configDir);
  const legacy = buildLegacyDocumentFromSecrets(configDir);
  const onInvalid = options.onInvalid ?? 'throw';

  if (!existsSync(path)) {
    writeConnectionProfilesDocument(configDir, legacy);
    return legacy;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (isValidConnectionDocument(parsed)) {
      if (options.preferLegacyRead && legacy.profiles[0]?.provider && legacy.assignments.llm.model) {
        if (options.hydrateFromLegacy) {
          writeConnectionProfilesDocument(configDir, legacy);
        }
        return legacy;
      }
      return parsed;
    }
    if (onInvalid === 'throw') {
      throw new Error('connections/profiles.json is invalid: expected CanonicalConnectionsDocument v1');
    }
  } catch {
    if (onInvalid === 'throw') {
      throw new Error('connections/profiles.json is invalid JSON or schema');
    }
  }

  writeConnectionProfilesDocument(configDir, legacy);
  return legacy;
}

export function ensureConnectionProfilesStore(configDir: string): void {
  mkdirSync(getConnectionProfilesDir(configDir), { recursive: true });
  if (!existsSync(getConnectionProfilesPath(configDir))) {
    const migrated = buildLegacyDocumentFromSecrets(configDir);
    writeConnectionProfilesDocument(configDir, migrated);
  }
}

type PrimaryConnectionInput = {
  provider: string;
  baseUrl: string;
  systemModel: string;
  embeddingModel: string;
  embeddingDims?: number;
};

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

export function writePrimaryConnectionProfile(
  configDir: string,
  input: PrimaryConnectionInput
): CanonicalConnectionsDocument {
  const secrets = readSecretsEnvFile(configDir);
  const provider = input.provider;
  const envKey = PROVIDER_KEY_MAP[provider] ?? 'OPENAI_API_KEY';
  const hasApiKey = hasApiKeyForProvider(provider, secrets);

  const document: CanonicalConnectionsDocument = {
    version: 1,
    profiles: [
      {
        id: 'primary',
        name: 'Primary connection',
        kind: normalizeConnectionKind(provider),
        provider,
        baseUrl: input.baseUrl,
        auth: {
          mode: hasApiKey ? 'api_key' : 'none',
          ...(hasApiKey ? { apiKeySecretRef: `env:${envKey}` } : {}),
        },
      },
    ],
    assignments: {
      llm: {
        connectionId: 'primary',
        model: input.systemModel,
      },
      embeddings: {
        connectionId: 'primary',
        model: input.embeddingModel,
        ...(input.embeddingDims && input.embeddingDims > 0 ? { embeddingDims: input.embeddingDims } : {}),
      },
    },
  };

  writeConnectionProfilesDocument(configDir, document);
  return document;
}

export function listConnectionProfiles(configDir: string): CanonicalConnectionProfile[] {
  return readConnectionProfilesDocumentWithOptions(configDir, {
    onInvalid: 'migrate',
  }).profiles;
}

export function getCapabilityAssignments(configDir: string): CapabilityAssignments {
  return readConnectionProfilesDocumentWithOptions(configDir, {
    onInvalid: 'migrate',
  }).assignments;
}

export function createConnectionProfile(
  configDir: string,
  profile: CanonicalConnectionProfile
): MutationResult<CanonicalConnectionProfile> {
  const validated = validateProfile(profile);
  if (!validated.ok) return validated;

  const document = readConnectionProfilesDocumentWithOptions(configDir, {
    onInvalid: 'migrate',
  });
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

  const document = readConnectionProfilesDocumentWithOptions(configDir, {
    onInvalid: 'migrate',
  });
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

  const document = readConnectionProfilesDocumentWithOptions(configDir, {
    onInvalid: 'migrate',
  });
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
  const document = readConnectionProfilesDocumentWithOptions(configDir, {
    onInvalid: 'migrate',
  });
  const profileIds = new Set(document.profiles.map((profile) => profile.id));
  const validated = validateAssignments(assignments, profileIds);
  if (!validated.ok) return validated;

  writeConnectionProfilesDocument(configDir, {
    ...document,
    assignments,
  });
  return { ok: true, value: assignments };
}
