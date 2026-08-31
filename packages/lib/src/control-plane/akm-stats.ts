import type { ControlPlaneState } from './types.js';
import { runAssistantAkmCommand, runAssistantCommand } from './assistant-akm.js';

type Json = Record<string, unknown>;

/**
 * Boot status marker written by the assistant entrypoint (tmpfs, rewritten from
 * scratch each boot, so it describes THIS boot only). One line per step:
 * `<step> <exit> [detail words...]`. akm boot failures are deliberately
 * non-fatal (#474), so this file is the only place a degraded scheduler becomes
 * visible. Absent on older assistant images — that is not degradation.
 */
const BOOT_MARKER_PATH = '/tmp/openpalm-akm-boot.status';

type AkmBootStep = { step: string; exit: number; detail: string | null };

type AkmBoot = { degraded: boolean; steps: AkmBootStep[] } | null;

export type AkmStats =
  | {
      available: false;
      reason: string;
      // Carried on this variant too: a boot so broken that akm itself cannot
      // answer is exactly when the boot record matters most. Dropping it here
      // would leave the operator with the same uninformative "unavailable"
      // string this marker exists to replace.
      boot: AkmBoot;
    }
  | {
      available: true;
      version: string | null;
      health: {
        status: 'pass' | 'warn' | 'unknown';
        advisories: string[];
      };
      boot: AkmBoot;
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

/** akm health exits 4 for "warn", which the entrypoint already treats as acceptable. */
function stepDegraded(step: AkmBootStep): boolean {
  if (step.step === 'health') return step.exit !== 0 && step.exit !== 4;
  return step.exit !== 0;
}

/** `null` stdout means the marker was absent or unreadable, which is not degradation. */
function parseBootMarker(stdout: string | null): AkmBoot {
  if (stdout === null) return null;
  const steps: AkmBootStep[] = [];
  for (const line of stdout.split('\n')) {
    const [step, exit, ...detail] = line.trim().split(/\s+/);
    const code = Number(exit);
    if (!step || !Number.isInteger(code)) continue;
    steps.push({ step, exit: code, detail: detail.length ? detail.join(' ') : null });
  }
  // No parsable steps is no data, not a clean boot: an empty marker means the
  // recorder itself failed, so reporting degraded:false would invert the point.
  if (steps.length === 0) return null;
  return { degraded: steps.some(stepDegraded), steps };
}

export function parseAkmStats(
  healthStdout: string,
  infoStdout: string,
  proposalsStdout: string,
  bootStdout: string | null = null,
): AkmStats {
  const health = parseJsonObject(healthStdout);
  const info = parseJsonObject(infoStdout);
  const proposalsPayload = parseJsonObject(proposalsStdout);

  if (!health && !info) {
    return {
      available: false,
      reason: 'AKM stats unavailable on this host.',
      boot: parseBootMarker(bootStdout),
    };
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
    boot: parseBootMarker(bootStdout),
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

/** Never throws and never reports missing: an unreadable marker just yields no boot data. */
async function readBootMarker(state: ControlPlaneState): Promise<string | null> {
  try {
    const result = await runAssistantCommand(state, ['cat', BOOT_MARKER_PATH], 8_000);
    return result.ok ? result.stdout : null;
  } catch {
    return null;
  }
}

export async function getAkmStats(state: ControlPlaneState): Promise<AkmStats> {
  const [healthResult, infoResult, proposalsResult, bootStdout] = await Promise.all([
    runAkmJsonCommand(state, ['health'], 8_000, { allowExitCodes: [4] }),
    runAkmJsonCommand(state, ['info'], 8_000),
    runAkmJsonCommand(state, ['proposal', 'list', '--status', 'pending'], 12_000),
    readBootMarker(state),
  ]);

  if (healthResult.missing || infoResult.missing) {
    return {
      available: false,
      reason: 'The assistant AKM CLI is not available.',
      boot: parseBootMarker(bootStdout),
    };
  }

  return parseAkmStats(healthResult.stdout, infoResult.stdout, proposalsResult.stdout, bootStdout);
}
