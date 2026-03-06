import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createConnectionProfile,
  deleteConnectionProfile,
  ensureConnectionProfilesStore,
  getConnectionProfilesPath,
  readConnectionProfilesDocument,
  readConnectionProfilesDocumentWithOptions,
  saveCapabilityAssignments,
  updateConnectionProfile,
} from '../../admin/src/lib/server/connection-profiles.js';

const tempDirs: string[] = [];

function createTempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openpalm-r04-1-'));
  tempDirs.push(dir);
  return dir;
}

function writeSecretsEnv(configDir: string, content: string): void {
  writeFileSync(join(configDir, 'secrets.env'), `${content.trim()}\n`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('R04-1 migration from legacy secrets', () => {
  it('ensures and reads canonical profiles document from legacy keys', () => {
    const configDir = createTempConfigDir();
    writeSecretsEnv(
      configDir,
      `
SYSTEM_LLM_PROVIDER=groq
SYSTEM_LLM_BASE_URL=https://api.groq.com/openai
SYSTEM_LLM_MODEL=llama-3.3-70b-versatile
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMS=1536
GROQ_API_KEY=test-groq-key
      `
    );

    ensureConnectionProfilesStore(configDir);

    const profilesPath = getConnectionProfilesPath(configDir);
    expect(existsSync(profilesPath)).toBe(true);

    const document = readConnectionProfilesDocument(configDir);
    expect(document).toEqual({
      version: 1,
      profiles: [
        {
          id: 'primary',
          name: 'Primary connection',
          kind: 'openai_compatible_remote',
          provider: 'groq',
          baseUrl: 'https://api.groq.com/openai',
          auth: {
            mode: 'api_key',
            apiKeySecretRef: 'env:GROQ_API_KEY',
          },
        },
      ],
      assignments: {
        llm: {
          connectionId: 'primary',
          model: 'llama-3.3-70b-versatile',
        },
        embeddings: {
          connectionId: 'primary',
          model: 'text-embedding-3-small',
          embeddingDims: 1536,
        },
      },
    });

    const fromDisk = JSON.parse(readFileSync(profilesPath, 'utf8')) as unknown;
    expect(fromDisk).toEqual(document);
  });

  it('throws on malformed persisted document without clobbering file', () => {
    const configDir = createTempConfigDir();
    writeSecretsEnv(configDir, 'SYSTEM_LLM_PROVIDER=openai\nSYSTEM_LLM_MODEL=gpt-4o-mini\n');

    const profilesPath = getConnectionProfilesPath(configDir);
    mkdirSync(join(configDir, 'connections'), { recursive: true });
    writeFileSync(profilesPath, '{"version":1,"profiles":', 'utf8');

    expect(() => readConnectionProfilesDocument(configDir)).toThrow(
      'connections/profiles.json is invalid JSON or schema'
    );
    expect(readFileSync(profilesPath, 'utf8')).toBe('{"version":1,"profiles":');
  });

  it('only repairs malformed file when onInvalid is explicitly migrate', () => {
    const configDir = createTempConfigDir();
    writeSecretsEnv(
      configDir,
      [
        'SYSTEM_LLM_PROVIDER=groq',
        'SYSTEM_LLM_MODEL=llama-3.3-70b-versatile',
        'EMBEDDING_MODEL=text-embedding-3-small',
      ].join('\n') + '\n'
    );

    const profilesPath = getConnectionProfilesPath(configDir);
    mkdirSync(join(configDir, 'connections'), { recursive: true });
    writeFileSync(profilesPath, '{"version":1,"profiles":', 'utf8');

    expect(() => readConnectionProfilesDocumentWithOptions(configDir, {})).toThrow(
      'connections/profiles.json is invalid JSON or schema'
    );
    expect(readFileSync(profilesPath, 'utf8')).toBe('{"version":1,"profiles":');

    const repaired = readConnectionProfilesDocumentWithOptions(configDir, { onInvalid: 'migrate' });
    expect(repaired.version).toBe(1);
    expect(repaired.profiles[0]?.provider).toBe('groq');
    expect(readFileSync(profilesPath, 'utf8')).toContain('"version": 1');
  });
});

describe('R04-1 profile CRUD conflict handling', () => {
  it('returns 409 for duplicate create and 404 for missing update', () => {
    const configDir = createTempConfigDir();
    writeSecretsEnv(
      configDir,
      `
SYSTEM_LLM_PROVIDER=openai
SYSTEM_LLM_MODEL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=test-openai-key
      `
    );

    ensureConnectionProfilesStore(configDir);

    const duplicate = createConnectionProfile(configDir, {
      id: 'primary',
      name: 'Duplicate primary',
      kind: 'openai_compatible_remote',
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      auth: {
        mode: 'api_key',
        apiKeySecretRef: 'env:OPENAI_API_KEY',
      },
    });
    expect(duplicate).toEqual({
      ok: false,
      status: 409,
      message: 'profile already exists: primary',
    });

    const missing = updateConnectionProfile(configDir, {
      id: 'missing-profile',
      name: 'Missing profile',
      kind: 'openai_compatible_remote',
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      auth: {
        mode: 'none',
      },
    });
    expect(missing).toEqual({
      ok: false,
      status: 404,
      message: 'profile not found: missing-profile',
    });
  });

  it('returns 409 when deleting a profile referenced by assignments', () => {
    const configDir = createTempConfigDir();
    writeSecretsEnv(
      configDir,
      [
        'SYSTEM_LLM_PROVIDER=openai',
        'SYSTEM_LLM_MODEL=gpt-4o-mini',
        'EMBEDDING_MODEL=text-embedding-3-small',
      ].join('\n') + '\n'
    );

    ensureConnectionProfilesStore(configDir);

    const result = deleteConnectionProfile(configDir, 'primary');
    expect(result).toEqual({
      ok: false,
      status: 409,
      message: 'profile is in use by assignments: primary',
    });
  });
});

describe('R04-1 assignment save validation', () => {
  it('returns 409 for missing connection id and 400 for invalid embedding dims', () => {
    const configDir = createTempConfigDir();
    writeSecretsEnv(
      configDir,
      `
SYSTEM_LLM_PROVIDER=openai
SYSTEM_LLM_MODEL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=test-openai-key
      `
    );

    ensureConnectionProfilesStore(configDir);

    const missingConnection = saveCapabilityAssignments(configDir, {
      llm: {
        connectionId: 'missing-profile',
        model: 'gpt-4o-mini',
      },
      embeddings: {
        connectionId: 'primary',
        model: 'text-embedding-3-small',
      },
    });
    expect(missingConnection).toEqual({
      ok: false,
      status: 409,
      message: 'assignments.llm.connectionId not found: missing-profile',
    });

    const invalidEmbeddingDims = saveCapabilityAssignments(configDir, {
      llm: {
        connectionId: 'primary',
        model: 'gpt-4o-mini',
      },
      embeddings: {
        connectionId: 'primary',
        model: 'text-embedding-3-small',
        embeddingDims: 0,
      },
    });
    expect(invalidEmbeddingDims).toEqual({
      ok: false,
      status: 400,
      message: 'assignments.embeddings.embeddingDims must be a positive integer',
    });
  });

  it('succeeds for valid assignment save', () => {
    const configDir = createTempConfigDir();
    writeSecretsEnv(
      configDir,
      `
SYSTEM_LLM_PROVIDER=openai
SYSTEM_LLM_MODEL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=test-openai-key
      `
    );

    ensureConnectionProfilesStore(configDir);

    const assignments = {
      llm: {
        connectionId: 'primary',
        model: 'gpt-4.1-mini',
      },
      embeddings: {
        connectionId: 'primary',
        model: 'text-embedding-3-large',
        embeddingDims: 3072,
      },
    };

    const result = saveCapabilityAssignments(configDir, assignments);
    expect(result).toEqual({
      ok: true,
      value: assignments,
    });

    const persisted = readConnectionProfilesDocument(configDir);
    expect(persisted.assignments).toEqual(assignments);
  });
});
