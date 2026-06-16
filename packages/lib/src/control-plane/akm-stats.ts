import type { ControlPlaneState } from './types.js';
import { runAssistantAkmCommand } from './assistant-akm.js';

type Json = Record<string, unknown>;

export type AkmStats =
  | {
      available: false;
      reason: string;
    }
  | {
      available: true;
      version: string | null;
      health: {
        status: 'pass' | 'warn' | 'unknown';
        advisories: string[];
      };
      index: {
        entryCount: number | null;
        lastBuiltAt: string | null;
        hasEmbeddings: boolean | null;
        vecAvailable: boolean | null;
      };
      assetCounts: {
        memory: number | null;
        skill: number | null;
        lesson: number | null;
      };
      improve: {
        invoked: number | null;
        completed: number | null;
        skipped: number | null;
        reflectOk: number | null;
        reflectCooldown: number | null;
        consolidation: {
          promoted: number | null;
          merged: number | null;
          deleted: number | null;
        };
      };
      proposals: {
        pending: number;
        items: Array<{
          ref: string | null;
          generator: string | null;
          createdAt: string | null;
          status: string | null;
        }>;
      };
    };

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parseJsonObject(stdout: string): Json | null {
  try {
    const parsed = JSON.parse(stdout);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function runAkmJsonCommand(
  state: ControlPlaneState,
  args: string[],
  timeoutMs: number,
  options: { allowExitCodes?: number[] } = {},
) {
  return runAssistantAkmCommand(state, [...args, '--format', 'json', '--quiet'], timeoutMs, options);
}

function readAssetCount(info: Json | null, type: string): number | null {
  if (!info) return null;
  const candidates = [
    asRecord(info.assetCounts),
    asRecord(info.assetTypeCounts),
    asRecord(info.assetsByType),
    asRecord(info.counts),
  ];
  for (const candidate of candidates) {
    const value = asNumber(candidate?.[type]);
    if (value !== null) return value;
  }
  return null;
}

function advisoryMessage(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return null;
  return asString(record.message) ?? asString(record.name);
}

export function parseAkmStats(
  healthStdout: string,
  infoStdout: string,
  proposalsStdout: string,
): AkmStats {
  const health = parseJsonObject(healthStdout);
  const info = parseJsonObject(infoStdout);
  const proposalsPayload = parseJsonObject(proposalsStdout);

  if (!health && !info) {
    return { available: false, reason: 'AKM stats unavailable on this host.' };
  }

  const indexStats = asRecord(info?.indexStats);
  const improve = asRecord(health?.improve);
  const reflect = asRecord(improve?.reflect);
  const consolidation = asRecord(improve?.consolidation);
  const proposals = asArray(proposalsPayload?.proposals)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Json => entry !== null)
    .map((entry) => ({
      ref: asString(entry.ref),
      generator: asString(entry.generator) ?? asString(entry.source),
      createdAt: asString(entry.createdAt),
      status: asString(entry.status),
    }));

  const rawStatus = asString(health?.status)?.toLowerCase();
  const status = rawStatus === 'pass' || rawStatus === 'ok'
    ? 'pass'
    : rawStatus === 'warn'
      ? 'warn'
      : 'unknown';

  return {
    available: true,
    version: asString(info?.version),
    health: {
      status,
      advisories: asArray(health?.advisories)
        .map((entry) => advisoryMessage(entry))
        .filter((entry): entry is string => entry !== null),
    },
    index: {
      entryCount: asNumber(indexStats?.entryCount),
      lastBuiltAt: asString(indexStats?.lastBuiltAt),
      hasEmbeddings: asBoolean(indexStats?.hasEmbeddings),
      vecAvailable: asBoolean(indexStats?.vecAvailable),
    },
    assetCounts: {
      memory: readAssetCount(info, 'memory'),
      skill: readAssetCount(info, 'skill'),
      lesson: readAssetCount(info, 'lesson'),
    },
    improve: {
      invoked: asNumber(improve?.invoked),
      completed: asNumber(improve?.completed),
      skipped: asNumber(improve?.skipped),
      reflectOk: asNumber(reflect?.ok),
      reflectCooldown: asNumber(reflect?.cooldown),
      consolidation: {
        promoted: asNumber(consolidation?.promoted),
        merged: asNumber(consolidation?.merged),
        deleted: asNumber(consolidation?.deleted),
      },
    },
    proposals: {
      pending: proposals.length,
      items: proposals,
    },
  };
}

export async function getAkmStats(state: ControlPlaneState): Promise<AkmStats> {
  const [healthResult, infoResult, proposalsResult] = await Promise.all([
    runAkmJsonCommand(state, ['health'], 8_000, { allowExitCodes: [4] }),
    runAkmJsonCommand(state, ['info'], 8_000),
    runAkmJsonCommand(state, ['proposal', 'list', '--status', 'pending'], 12_000),
  ]);

  if (healthResult.missing || infoResult.missing) {
    return { available: false, reason: 'The assistant AKM CLI is not available.' };
  }

  return parseAkmStats(healthResult.stdout, infoResult.stdout, proposalsResult.stdout);
}
