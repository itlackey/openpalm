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
  readConnectionProfilesDocumentWithOptions,
  saveCapabilityAssignments,
  updateConnectionProfile,
  writePrimaryConnectionProfile,
} from './connection-profiles.js';
import { makeTempDir, registerCleanup, seedSecretsEnv, trackDir } from './test-helpers.js';

registerCleanup();

describe('connection profiles storage', () => {
  test('ensures canonical storage file exists in CONFIG_HOME/connections', () => {
    const configDir = trackDir(makeTempDir());
    seedSecretsEnv(configDir, 'SYSTEM_LLM_PROVIDER=openai\nSYSTEM_LLM_MODEL=gpt-4.1-mini\n');

    ensureConnectionProfilesStore(configDir);

    const path = getConnectionProfilesPath(configDir);
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(configDir, 'connections', 'profiles.json'));
  });

  test('migrates from legacy singleton env keys on first read', () => {
    const configDir = trackDir(makeTempDir());
    seedSecretsEnv(
      configDir,
      [
        'SYSTEM_LLM_PROVIDER=ollama',
        'SYSTEM_LLM_BASE_URL=http://host.docker.internal:11434',
        'SYSTEM_LLM_MODEL=qwen3:0.6b',
        'EMBEDDING_MODEL=nomic-embed-text',
        'EMBEDDING_DIMS=768',
      ].join('\n') + '\n'
    );

    const document = readConnectionProfilesDocument(configDir);

    expect(document.version).toBe(1);
    expect(document.profiles).toHaveLength(1);
    expect(document.profiles[0].provider).toBe('ollama');
    expect(document.profiles[0].kind).toBe('openai_compatible_local');
    expect(document.assignments.llm.model).toBe('qwen3:0.6b');
    expect(document.assignments.embeddings.model).toBe('nomic-embed-text');
    expect(document.assignments.embeddings.embeddingDims).toBe(768);
  });

  test('supports preferLegacyRead hydration without destructive side effects', () => {
    const configDir = trackDir(makeTempDir());
    seedSecretsEnv(
      configDir,
      [
        'SYSTEM_LLM_PROVIDER=openai',
        'SYSTEM_LLM_BASE_URL=https://api.openai.com',
        'SYSTEM_LLM_MODEL=gpt-4.1-mini',
        'EMBEDDING_MODEL=text-embedding-3-small',
        'EMBEDDING_DIMS=1536',
      ].join('\n') + '\n'
    );

    ensureConnectionProfilesStore(configDir);
    const canonical = readConnectionProfilesDocument(configDir);
    expect(canonical.profiles[0].provider).toBe('openai');

    seedSecretsEnv(
      configDir,
      [
        'SYSTEM_LLM_PROVIDER=ollama',
        'SYSTEM_LLM_BASE_URL=http://host.docker.internal:11434',
        'SYSTEM_LLM_MODEL=qwen3:0.6b',
        'EMBEDDING_MODEL=nomic-embed-text',
        'EMBEDDING_DIMS=768',
      ].join('\n') + '\n'
    );

    const preferred = readConnectionProfilesDocumentWithOptions(configDir, {
      preferLegacyRead: true,
      hydrateFromLegacy: true,
    });
    expect(preferred.profiles[0].provider).toBe('ollama');

    const hydrated = readConnectionProfilesDocument(configDir);
    expect(hydrated.profiles[0].provider).toBe('ollama');
  });

  test('writes primary canonical profile while preserving legacy secrets file', () => {
    const configDir = trackDir(makeTempDir());
    seedSecretsEnv(
      configDir,
      [
        'OPENAI_API_KEY=sk-test',
        'SYSTEM_LLM_PROVIDER=openai',
        'SYSTEM_LLM_MODEL=gpt-4.1-mini',
        'EMBEDDING_MODEL=text-embedding-3-small',
      ].join('\n') + '\n'
    );

    const document = writePrimaryConnectionProfile(configDir, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      systemModel: 'gpt-4.1-mini',
      embeddingModel: 'text-embedding-3-small',
      embeddingDims: 1536,
    });

    expect(document.profiles[0].auth.mode).toBe('api_key');
    expect(document.profiles[0].auth.apiKeySecretRef).toBe('env:OPENAI_API_KEY');
    expect(readFileSync(join(configDir, 'secrets.env'), 'utf8')).toContain('OPENAI_API_KEY=sk-test');
    expect(readFileSync(getConnectionProfilesPath(configDir), 'utf8')).toContain('"version": 1');
  });

  test('supports profile CRUD with deterministic conflicts', () => {
    const configDir = trackDir(makeTempDir());
    seedSecretsEnv(
      configDir,
      'SYSTEM_LLM_PROVIDER=openai\nSYSTEM_LLM_MODEL=gpt-4.1-mini\nEMBEDDING_MODEL=text-embedding-3-small\n'
    );
    ensureConnectionProfilesStore(configDir);

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

  test('validates assignment save and blocks dangling connection ids', () => {
    const configDir = trackDir(makeTempDir());
    seedSecretsEnv(configDir, 'SYSTEM_LLM_PROVIDER=openai\nSYSTEM_LLM_MODEL=gpt-4.1-mini\nEMBEDDING_MODEL=text-embedding-3-small\n');
    ensureConnectionProfilesStore(configDir);

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
