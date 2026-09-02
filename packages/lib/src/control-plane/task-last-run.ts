/**
 * Per-task "last run" status for the Automations tab (#677).
 *
 * `akm task history --format json --quiet` (no `--id`) returns every task's
 * recent runs, newest first, in one `{ rows: [...] }` call — reducing that
 * into "the newest row per task id" is a pure, easily-tested transform kept
 * separate from the akm-invocation boundary so the route stays thin.
 */
import type { ControlPlaneState } from './types.js';
import { runAssistantAkmCommand } from './assistant-akm.js';

type Json = Record<string, unknown>;

/** The subset of `akm task history`'s row shape this feature reads. */
export interface TaskHistoryRow {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

export interface TaskLastRun {
  status: string;
  at: string | null;
  exitCode: number | null;
}

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Defensively decode `akm task history --format json`'s stdout into the row
 * shape this feature needs. Any row missing `id`/`status`/`startedAt` is
 * dropped rather than failing the whole parse — malformed akm output must
 * degrade the per-task signal, not the automations listing.
 */
export function parseTaskHistoryRows(stdout: string): TaskHistoryRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const envelope = asRecord(parsed);
  const rawRows = envelope?.rows;
  if (!Array.isArray(rawRows)) return [];

  const rows: TaskHistoryRow[] = [];
  for (const entry of rawRows) {
    const row = asRecord(entry);
    const id = asString(row?.id);
    const status = asString(row?.status);
    const startedAt = asString(row?.startedAt);
    if (!row || !id || !status || !startedAt) continue;
    const detail = asRecord(row.detail);
    rows.push({
      id,
      status,
      startedAt,
      finishedAt: asString(row.finishedAt),
      exitCode: asNumber(detail?.exitCode),
    });
  }
  return rows;
}

/**
 * Reduce history rows (any order) to the single newest row per task id.
 * Ranks by `startedAt` (ISO-8601 UTC, so lexical order is chronological
 * order — same convention `readAutomationLogs` already relies on) rather
 * than trusting the caller's row order, so a future change to
 * `readTaskHistory`'s ordering can't silently pick a stale run.
 */
export function computeLastRunsByTaskId(rows: readonly TaskHistoryRow[]): Record<string, TaskLastRun> {
  const newestStartedAt = new Map<string, string>();
  const result: Record<string, TaskLastRun> = {};

  for (const row of rows) {
    const current = newestStartedAt.get(row.id);
    if (current !== undefined && row.startedAt <= current) continue;
    newestStartedAt.set(row.id, row.startedAt);
    result[row.id] = {
      status: row.status,
      at: row.finishedAt ?? row.startedAt,
      exitCode: row.exitCode,
    };
  }

  return result;
}

/**
 * Best-effort per-task last-run lookup for the automations listing. ANY
 * failure (missing akm, timeout, unparseable output) yields `{}` — this
 * must never fail the automations listing itself (#677: the point of this
 * feature is to surface failures more visibly, not to add a new one).
 */
export async function fetchTaskHistoryLastRuns(
  state: ControlPlaneState,
  timeoutMs = 10_000,
): Promise<Record<string, TaskLastRun>> {
  try {
    const result = await runAssistantAkmCommand(
      state,
      ['task', 'history', '--limit', '500', '--format', 'json', '--quiet'],
      timeoutMs,
    );
    if (!result.ok || result.missing) return {};
    return computeLastRunsByTaskId(parseTaskHistoryRows(result.stdout));
  } catch {
    return {};
  }
}
