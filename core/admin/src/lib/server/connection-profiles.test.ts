import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createConnectionProfile,
  deleteConnectionProfile,
  ensureConnectionProfilesStore,
  getCapabilityAssignments,
  getConnectionProfilesPath,
  readConnectionProfilesDocument,
  saveCapabilityAssignments,
  updateConnectionProfile,
  writeConnectionsDocument,
  writeConnectionProfilesDocument,
} from './connection-profiles.js';
import { makeTempDir, registerCleanup, trackDir } from './test-helpers.js';

registerCleanup();

describe('connection profiles storage', () => {
  test('ensures connections directory exists', () => {
    const configDir = trackDir(makeTempDir());
    ensureConnectionProfilesStore(configDir);
    const path = getConnectionProfilesPath(configDir);
    expect(path).toBe(join(configDir, 'connections', 'profiles.json'));
  });

  test('readConnectionProfilesDocument throws when file does not exist', () => {
    const configDir = trackDir(makeTempDir());
    ensureConnectionProfilesStore(configDir);
    expect(() => readConnectionProfilesDocument(configDir)).toThrow('does not exist');
  });

  test('writeConnectionsDocument creates valid canonical document', () => {
    const configDir = trackDir(makeTempDir());
    const document = writeConnectionsDocument(configDir, {
      profiles: [
        {
          id: 'primary',
          name: 'OpenAI',
          provider: 'openai',
          baseUrl: 'https://api.openai.com',
          hasApiKey: true,
          apiKeyEnvVar: 'OPENAI_API_KEY',
        },
      ],
      assignments: {
        llm: { connectionId: 'primary', model: 'gpt-4.1-mini' },
        embeddings: { connectionId: 'primary', model: 'text-embedding-3-small', embeddingDims: 1536 },
      },
    });

    expect(document.version).toBe(1);
    expect(document.profiles).toHaveLength(1);
    expect(document.profiles[0].auth.mode).toBe('api_key');
    expect(document.profiles[0].auth.apiKeySecretRef).toBe('env:OPENAI_API_KEY');
    expect(document.assignments.llm.model).toBe('gpt-4.1-mini');

    // File should be readable
    const read = readConnectionProfilesDocument(configDir);
    expect(read).toEqual(document);
  });

  test('writeConnectionsDocument supports multiple profiles', () => {
    const configDir = trackDir(makeTempDir());
    const document = writeConnectionsDocument(configDir, {
      profiles: [
        {
          id: 'cloud',
          name: 'OpenAI',
          provider: 'openai',
          baseUrl: '',
          hasApiKey: true,
          apiKeyEnvVar: 'OPENAI_API_KEY',
        },
        {
          id: 'local',
          name: 'Ollama',
          provider: 'ollama',
          baseUrl: 'http://ollama:11434',
          hasApiKey: false,
          apiKeyEnvVar: '',
        },
      ],
      assignments: {
        llm: { connectionId: 'local', model: 'llama3.2:3b' },
        embeddings: { connectionId: 'cloud', model: 'text-embedding-3-small', embeddingDims: 1536 },
      },
    });

    expect(document.profiles).toHaveLength(2);
    expect(document.profiles[0].kind).toBe('openai_compatible_remote');
    expect(document.profiles[1].kind).toBe('openai_compatible_local');
    expect(document.assignments.llm.connectionId).toBe('local');
    expect(document.assignments.embeddings.connectionId).toBe('cloud');
  });

  test('supports profile CRUD with deterministic conflicts', () => {
    const configDir = trackDir(makeTempDir());

    // Seed a valid document first
    writeConnectionsDocument(configDir, {
      profiles: [{
        id: 'primary',
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: '',
        hasApiKey: true,
        apiKeyEnvVar: 'OPENAI_API_KEY',
      }],
      assignments: {
        llm: { connectionId: 'primary', model: 'gpt-4.1-mini' },
        embeddings: { connectionId: 'primary', model: 'text-embedding-3-small', embeddingDims: 1536 },
      },
    });

    const profile = {
      id: 'local-lmstudio',
      name: 'LM Studio',
      kind: 'openai_compatible_local' as const,
      provider: 'lmstudio',
      baseUrl: 'http://host.docker.internal:1234',
      auth: { mode: 'none' as const },
    };

    const created = createConnectionProfile(configDir, profile);
    expect(created.ok).toBe(true);

    const duplicate = createConnectionProfile(configDir, profile);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.status).toBe(409);
    }

    const updated = updateConnectionProfile(configDir, { ...profile, name: 'LM Studio Local' });
    expect(updated.ok).toBe(true);

    const deleted = deleteConnectionProfile(configDir, profile.id);
    expect(deleted.ok).toBe(true);
  });

  test('writeConnectionsDocument rejects empty profiles', () => {
    const configDir = trackDir(makeTempDir());
    expect(() => writeConnectionsDocument(configDir, {
      profiles: [],
      assignments: {
        llm: { connectionId: 'x', model: 'y' },
        embeddings: { connectionId: 'x', model: 'y' },
      },
    })).toThrow('profiles must not be empty');
  });

  test('writeConnectionsDocument rejects dangling assignment connectionIds', () => {
    const configDir = trackDir(makeTempDir());
    expect(() => writeConnectionsDocument(configDir, {
      profiles: [{
        id: 'primary',
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: '',
        hasApiKey: true,
        apiKeyEnvVar: 'OPENAI_API_KEY',
      }],
      assignments: {
        llm: { connectionId: 'missing', model: 'gpt-4.1-mini' },
        embeddings: { connectionId: 'primary', model: 'text-embedding-3-small' },
      },
    })).toThrow('llm.connectionId "missing" not found in profiles');
  });

  test('validates assignment save and blocks dangling connection ids', () => {
    const configDir = trackDir(makeTempDir());

    writeConnectionsDocument(configDir, {
      profiles: [{
        id: 'primary',
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: '',
        hasApiKey: true,
        apiKeyEnvVar: 'OPENAI_API_KEY',
      }],
      assignments: {
        llm: { connectionId: 'primary', model: 'gpt-4.1-mini' },
        embeddings: { connectionId: 'primary', model: 'text-embedding-3-small', embeddingDims: 1536 },
      },
    });

    const invalid = saveCapabilityAssignments(configDir, {
      llm: { connectionId: 'missing', model: 'gpt-4.1-mini' },
      embeddings: { connectionId: 'primary', model: 'text-embedding-3-small', embeddingDims: 1536 },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.status).toBe(409);
    }

    const valid = saveCapabilityAssignments(configDir, {
      llm: { connectionId: 'primary', model: 'gpt-4.1-mini' },
      embeddings: { connectionId: 'primary', model: 'text-embedding-3-small', embeddingDims: 1536 },
    });
    expect(valid.ok).toBe(true);
    expect(getCapabilityAssignments(configDir).llm.connectionId).toBe('primary');
  });
});
