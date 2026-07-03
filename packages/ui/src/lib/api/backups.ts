import { request, requireOk } from './core.js';

// ── Backups (#499) ───────────────────────────────────────────────────────────

export interface BackupEntryView {
  path: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BackupSummaryView {
  ok: boolean;
  count: number;
  totalBytes: number;
  lastBackupAt: string | null;
  backups: BackupEntryView[];
}

export async function fetchBackups(): Promise<BackupSummaryView> {
  const res = await requireOk(await request('GET', '/admin/backups'));
  return (await res.json()) as BackupSummaryView;
}

/** Drives the confirm-gated prune — keeps the newest `keep`, deletes older. */
export async function pruneBackups(keep: number): Promise<{ ok: boolean; deleted: string[]; kept: number }> {
  const res = await requireOk(await request('POST', '/admin/backups', { keep }));
  return (await res.json()) as { ok: boolean; deleted: string[]; kept: number };
}

// ── Secret-strip notice (#502) ───────────────────────────────────────────────

export async function fetchSecretStripNotice(): Promise<{ ok: boolean; notice: { keys: string[]; at: string } | null }> {
  const res = await requireOk(await request('GET', '/admin/secret-notice'));
  return (await res.json()) as { ok: boolean; notice: { keys: string[]; at: string } | null };
}

export async function dismissSecretStripNotice(): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('DELETE', '/admin/secret-notice'));
  return (await res.json()) as { ok: boolean };
}

// ── Install lock / stuck-operation recovery (#500) ───────────────────────────

export interface InstallLockStatusView {
  ok: boolean;
  present: boolean;
  stale: boolean;
  pid: number | null;
  timestamp: number | null;
  ageMs: number | null;
  path: string;
  staleAfterMs: number;
}

export async function fetchInstallLockStatus(): Promise<InstallLockStatusView> {
  const res = await requireOk(await request('GET', '/admin/unlock'));
  return (await res.json()) as InstallLockStatusView;
}

/**
 * Clears a STALE install lock. Throws the server's plain-language message when
 * a live install is still holding it (HTTP 409) — never forces.
 */
export async function clearInstallLock(): Promise<{ ok: boolean; removed: boolean }> {
  const res = await requireOk(await request('POST', '/admin/unlock'));
  return (await res.json()) as { ok: boolean; removed: boolean };
}
