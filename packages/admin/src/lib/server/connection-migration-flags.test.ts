import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  detectConnectionCompatibilityMode,
  readConnectionMigrationFlags,
} from './connection-migration-flags.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('connection migration flags', () => {
  test('reads default migration flags', () => {
    const flags = readConnectionMigrationFlags();
    expect(flags.enabled).toBe(true);
    expect(flags.dualRead).toBe(true);
    expect(flags.dualWrite).toBe(true);
    expect(flags.preferLegacyRead).toBe(false);
    expect(flags.annotateAudit).toBe(true);
  });

  test('respects environment override flags', () => {
    process.env.OPENPALM_CONNECTION_MIGRATION_DUAL_READ = 'false';
    process.env.OPENPALM_CONNECTION_MIGRATION_PREFER_LEGACY_READ = 'true';
    const flags = readConnectionMigrationFlags();
    expect(flags.dualRead).toBe(false);
    expect(flags.preferLegacyRead).toBe(true);
  });

  test('detects canonical, unified, and legacy patch modes', () => {
    expect(detectConnectionCompatibilityMode({
      profiles: [],
      assignments: {},
    })).toBe('canonical_dto');
    expect(detectConnectionCompatibilityMode({ provider: 'openai' })).toBe('legacy_unified');
    expect(detectConnectionCompatibilityMode({ OPENAI_API_KEY: 'sk-test' })).toBe('legacy_patch');
  });
});
