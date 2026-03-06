type ConnectionCompatibilityMode =
  | 'legacy_patch'
  | 'legacy_unified'
  | 'canonical_dto';

export type ConnectionMigrationFlags = {
  enabled: boolean;
  dualRead: boolean;
  dualWrite: boolean;
  preferLegacyRead: boolean;
  annotateAudit: boolean;
};

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function readConnectionMigrationFlags(): ConnectionMigrationFlags {
  return {
    enabled: envFlag('OPENPALM_CONNECTION_MIGRATION_ENABLED', true),
    dualRead: envFlag('OPENPALM_CONNECTION_MIGRATION_DUAL_READ', true),
    dualWrite: envFlag('OPENPALM_CONNECTION_MIGRATION_DUAL_WRITE', true),
    preferLegacyRead: envFlag('OPENPALM_CONNECTION_MIGRATION_PREFER_LEGACY_READ', false),
    annotateAudit: envFlag('OPENPALM_CONNECTION_MIGRATION_AUDIT_ANNOTATION', true),
  };
}

export function detectConnectionCompatibilityMode(body: Record<string, unknown>): ConnectionCompatibilityMode {
  if (Array.isArray(body.profiles) && typeof body.assignments === 'object' && body.assignments !== null) {
    return 'canonical_dto';
  }
  if (typeof body.provider === 'string') {
    return 'legacy_unified';
  }
  return 'legacy_patch';
}

export type { ConnectionCompatibilityMode };
