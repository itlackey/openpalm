/**
 * akm SQLite journal-mode reconciliation — host-side WAL-residue heal.
 *
 * akm >= 0.9.6 (the pin shipped with 0.13.0) classifies the container's
 * /opt/akm/data bind mount as a network filesystem on Docker Desktop /
 * OrbStack (virtiofs) and refuses WAL, opening its stores in DELETE journal
 * mode. Correct — WAL needs the `-shm` shared-memory index and POSIX locks,
 * neither of which works across a VM file-sharing layer. But a home that ran
 * an OLDER akm (or a host-side akm against the same tree, where the mount is
 * a plain local directory) can carry WAL residue: `-wal` sidecars and/or a
 * WAL-mode main-file header. SQLite opens the WAL machinery whenever a
 * non-empty database has a `-wal` sidecar — BEFORE any journal_mode PRAGMA a
 * client issues — so the in-container akm cannot even get far enough to ask
 * for DELETE mode: every open fails "database is locked", the boot health
 * step exits 78 on every boot, and `akm workflow list --active` fails, while
 * the host opens the same file fine.
 *
 * The residue is worse than it looks. Observed live: a 4 KB `state.db` whose
 * header still said rollback-journal, next to a 1.1 MB `state.db-wal`
 * untouched for months — the ENTIRE database (schema, rows, even the header
 * flip to WAL mode) sat in un-checkpointed WAL frames. Deleting a `-wal`
 * without checkpointing therefore destroys real state; only folding it back
 * into the main file is safe, and only the host can do that (WAL + POSIX
 * locking work natively there).
 *
 * So: on every home-reconciliation pass (applyHomeAssets — install, update,
 * desktop launch, CLI supervisor spawn; deliberately NOT plain start/restart,
 * same reach as the akm config sweeps beside it), sweep the akm data roots
 * ({@link akmDataRoots} in home.ts — the same list ensureHomeDirs creates)
 * for SQLite files that carry WAL residue and, from the host, run
 * `PRAGMA wal_checkpoint(TRUNCATE)` followed by `PRAGMA journal_mode=DELETE`
 * — after which SQLite itself removes the `-wal` sidecar and the container
 * can open the store. This is deliberately a RECURRING reconcile and not a
 * `runHomeMigrations` entry: a schema-stamped home re-acquires the residue
 * from any host-side akm run against the same tree, so a run-once migration
 * cannot keep it healed.
 *
 * Platform gate: this runs ONLY on VM-mediated container runtimes, read from
 * describeHostRuntime()'s `bindMountsCrossVmFilesystem` (host-identity.ts —
 * the single seam that classifies native-Linux vs VM-mediated). There, bind
 * mounts ALWAYS cross virtiofs/gRPC-FUSE/9p, so a WAL-mode store under an akm
 * data root is by construction unopenable by the container and converting it
 * can never contend with a live in-container writer. On native Linux the
 * opposite holds: akm legitimately uses WAL on the (local) bind mount and may
 * be writing right now — converting would fight a live writer and akm would
 * flip it straight back. (Docker Desktop *for Linux* is the one VM-mediated
 * shape the seam cannot currently see; the upgrade runbook documents the
 * manual host-side sqlite3 command for it, and a future refinement inside
 * describeHostRuntime extends this sweep automatically.)
 *
 * Detection is by content, not filename: akm's stores are `*.db`
 * (state/workflow/index/logs) but it also keeps SQLite files under other
 * names (e.g. `.maintenance.barrier.lock.operations.sensitive`), so every
 * file under the roots is sniffed for the 16-byte SQLite magic. A store
 * needs conversion when a `-wal` sidecar sits beside it (the live shape —
 * the header alone can still claim rollback mode, see above) OR its header
 * bytes 18/19 mark WAL (a cleanly-closed WAL db keeps those bytes without
 * any sidecar, and re-creates the sidecar on next open). Healthy
 * rollback-mode stores are never even opened — the running container may
 * hold them. `.bak` snapshots are excluded outright: nothing opens them, and
 * converting one would mutate an operator's backup.
 *
 * Failure posture matches its applyHomeAssets neighbours: never throw. A
 * store that cannot be converted (locked by a concurrent host process,
 * driver unavailable, sweep lock-wait budget spent) is logged and left
 * exactly as found; the next lifecycle pass retries. Orphaned `-wal` files
 * (no companion database) are reported and NEVER deleted.
 */
import type { Dirent } from "node:fs";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { errMessage } from "./errors.js";
import { akmDataRoots } from "./home.js";
import { describeHostRuntime } from "./host-identity.js";
import type { HostRuntime } from "./host-identity.js";
// The shared lazy driver seam (see sqlite-driver.ts for the barrel constraint
// and the node:sqlite fallback this module's Electron call path relies on).
// Driver-unavailable is non-fatal here: the sweep reports the stores it left
// behind and the next CLI-driven lifecycle pass (Bun) heals them.
import { loadSqliteOpen } from "./sqlite-driver.js";
import type { SqliteConnection, SqliteOpen } from "./sqlite-driver.js";
import type { ControlPlaneState } from "./types.js";

const logger = createLogger("akm-db-journal");

// ── Header sniffing (never takes a lock) ─────────────────────────────────────

/** First 16 bytes of every SQLite database file: "SQLite format 3" + NUL. */
const SQLITE_MAGIC = Buffer.from("SQLite format 3\u0000", "latin1");

/**
 * Read-only 20-byte sniff. Returns header info for a readable SQLite database
 * file and null for anything else (non-SQLite, too short, unreadable) — the
 * sweep treats all of those identically: not a conversion candidate.
 *
 * `walHeader` is header bytes 18/19 (file-format write/read version): 1 =
 * rollback journal, 2 = WAL. NOTE: false does not prove the store is WAL-free
 * — the header flip itself can sit in an un-checkpointed `-wal` (the observed
 * live shape) — which is why sidecar presence is checked independently.
 */
function sniffSqliteHeader(path: string): { walHeader: boolean } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const header = Buffer.alloc(20);
    if (readSync(fd, header, 0, 20, 0) < 20 || !header.subarray(0, 16).equals(SQLITE_MAGIC)) {
      return null;
    }
    return { walHeader: header[18] === 2 || header[19] === 2 };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// ── Tree walk ────────────────────────────────────────────────────────────────

/**
 * All regular files under `root`, recursively. Symlinks are never followed
 * (the sweep must not reach outside the akm data root), and an unreadable
 * subtree — including a missing `root` — is skipped rather than aborting the
 * sweep: container-written subdirectories can be 0700 under a different uid
 * on some deployments.
 */
function walkFiles(root: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkFiles(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function statSizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ── Conversion ───────────────────────────────────────────────────────────────

export type AkmDbJournalAction = "converted" | "failed" | "orphaned-wal";

export interface AkmDbJournalEntry {
  /**
   * The affected database file. For `orphaned-wal` it is the missing
   * companion the sidecar implies; for a root-wide failure (no SQLite driver
   * in this runtime) it is the sweep root itself.
   */
  dbPath: string;
  action: AkmDbJournalAction;
  /** Bytes of `-wal` sidecar involved; 0 when the trigger was a WAL header with no sidecar. */
  walBytes: number;
  detail?: string;
}

export interface AkmDbJournalSweepResult {
  root: string;
  /** Candidate files inspected under `root` (header sniff — sidecars and `.bak` snapshots excluded). */
  scanned: number;
  /**
   * Noteworthy outcomes only: conversions, failures, orphaned `-wal`s.
   * Healthy rollback-mode stores and non-SQLite files are counted in
   * `scanned` and omitted, so this sweep is silent on a healthy home.
   */
  entries: AkmDbJournalEntry[];
}

/**
 * Checkpoint the WAL into the main file, then flip the store to DELETE
 * journal mode. Ordering matters: `journal_mode=DELETE` alone silently stays
 * on "wal" when it cannot take the exclusive lock, and the checkpoint is
 * what preserves the WAL's content — never delete or bypass a `-wal`.
 * SQLite removes the `-wal` sidecar itself on a successful flip.
 */
function convertDb(
  open: SqliteOpen,
  dbPath: string,
  walBytes: number,
  busyTimeoutMs: number,
): AkmDbJournalEntry {
  const fail = (detail: string): AkmDbJournalEntry => ({
    dbPath,
    action: "failed",
    walBytes,
    detail,
  });
  let conn: SqliteConnection;
  try {
    conn = open(dbPath);
  } catch (error) {
    return fail(`open failed: ${errMessage(error)}`);
  }
  try {
    // Tolerate a briefly-held host-side lock, within what remains of the
    // sweep-wide budget — a store wedged longer is left for the next pass.
    conn.pragmaRow(`busy_timeout = ${busyTimeoutMs}`);
    const checkpoint = conn.pragmaRow("wal_checkpoint(TRUNCATE)");
    if (!checkpoint || Number(checkpoint.busy) !== 0) {
      return fail("wal_checkpoint(TRUNCATE) could not complete (database busy)");
    }
    const modeRow = conn.pragmaRow("journal_mode = DELETE");
    const mode = String(modeRow?.journal_mode ?? "unknown").toLowerCase();
    if (mode !== "delete") {
      return fail(`journal_mode is still "${mode}" after PRAGMA journal_mode=DELETE`);
    }
  } catch (error) {
    return fail(errMessage(error));
  } finally {
    try {
      conn.close();
    } catch {
      // A close failure must not mask the conversion outcome.
    }
  }
  if (existsSync(`${dbPath}-wal`)) {
    // Both PRAGMAs reported success but the sidecar survived — treat as not
    // converted so the next pass retries instead of trusting a half-state.
    return fail("-wal sidecar still present after conversion");
  }
  // A leftover `-shm` is safe to remove once the `-wal` is gone: it is a
  // rebuildable shared-memory index into the (now checkpointed) WAL, never
  // durable state — unlike the `-wal`, which this module never deletes. The
  // connection that just left WAL mode does not clean it up on close.
  try {
    unlinkSync(`${dbPath}-shm`);
  } catch {
    // Absent or unremovable — either way harmless: rollback-mode opens never
    // consult the -shm.
  }
  return { dbPath, action: "converted", walBytes };
}

/** SQLite's own sidecar files — never conversion candidates themselves. */
const SIDECAR_SUFFIX = /-(?:wal|shm|journal)$/;

/**
 * Backup snapshots (e.g. the runbook's `state.db.manual-backup-<ts>.bak`):
 * SQLite content nothing ever opens. Converting one would mutate an
 * operator's backup, so they are excluded before the sniff.
 */
const BACKUP_SUFFIX = /\.bak$/;

/**
 * Approximate lock-wait budget for one whole sweep, not per store. An
 * incident-shape tree can carry dozens of candidates, and this runs
 * synchronously on the install/update/launch path — a per-store timeout
 * would let one lock contender stall the pass for minutes. Whatever the
 * budget cannot cover is reported and retried on the next pass.
 */
const SWEEP_BUSY_BUDGET_MS = 5000;

/**
 * Sweep one directory tree for SQLite stores carrying WAL residue and
 * convert each to DELETE journal mode via checkpoint-first. Unconditional —
 * the runtime/root policy lives in {@link reconcileAkmDbJournalMode}.
 * Never throws.
 */
export function convertWalDbsToDeleteJournal(root: string): AkmDbJournalSweepResult {
  const result: AkmDbJournalSweepResult = { root, scanned: 0, entries: [] };
  const files = walkFiles(root);
  const fileSet = new Set(files);

  const candidates: Array<{ dbPath: string; walBytes: number }> = [];
  for (const file of files) {
    if (SIDECAR_SUFFIX.test(file) || BACKUP_SUFFIX.test(file)) continue;
    result.scanned += 1;
    const info = sniffSqliteHeader(file);
    if (!info) continue;
    const hasWal = fileSet.has(`${file}-wal`);
    // Healthy rollback-mode store — never even opened (a live container may hold it).
    if (!hasWal && !info.walHeader) continue;
    candidates.push({ dbPath: file, walBytes: hasWal ? statSizeOrZero(`${file}-wal`) : 0 });
  }

  if (candidates.length > 0) {
    const open = loadSqliteOpen();
    if (!open) {
      // One aggregate entry, not one per store: a runtime with no SQLite
      // driver hits this on every launch, and per-store entries would warn
      // dozens of times for one unfixable cause.
      result.entries.push({
        dbPath: root,
        action: "failed",
        walBytes: candidates.reduce((sum, c) => sum + c.walBytes, 0),
        detail: `no SQLite driver available in this runtime (tried bun:sqlite, node:sqlite); ${candidates.length} store(s) need conversion`,
      });
    } else {
      const deadline = Date.now() + SWEEP_BUSY_BUDGET_MS;
      for (const candidate of candidates) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          result.entries.push({
            ...candidate,
            action: "failed",
            detail: "sweep lock-wait budget exhausted; retrying on the next lifecycle pass",
          });
          continue;
        }
        result.entries.push(convertDb(open, candidate.dbPath, candidate.walBytes, remainingMs));
      }
    }
  }

  // A `-wal` with no companion database cannot be checkpointed, and a WAL can
  // hold real state — report it and leave it exactly where it is.
  for (const file of files) {
    if (!file.endsWith("-wal")) continue;
    const base = file.slice(0, -"-wal".length);
    if (fileSet.has(base)) continue;
    result.entries.push({
      dbPath: base,
      action: "orphaned-wal",
      walBytes: statSizeOrZero(file),
      detail: "-wal sidecar has no companion database file; left in place",
    });
  }
  return result;
}

// ── Lifecycle wiring ─────────────────────────────────────────────────────────

/**
 * Heal WAL residue under every akm data root ({@link akmDataRoots}),
 * host-side, before the stack starts. No-op on native Linux, where
 * in-container WAL is legitimate and possibly live — the classification is
 * read from {@link describeHostRuntime}, the one seam that owns it. Never
 * throws — failures are logged and retried on the next lifecycle pass.
 * `runtime` is injectable for tests only.
 */
export function reconcileAkmDbJournalMode(
  state: Pick<ControlPlaneState, "homeDir">,
  runtime: HostRuntime = describeHostRuntime(),
): AkmDbJournalSweepResult[] {
  if (!runtime.bindMountsCrossVmFilesystem) return [];
  const results: AkmDbJournalSweepResult[] = [];
  for (const root of akmDataRoots(state.homeDir)) {
    try {
      const sweep = convertWalDbsToDeleteJournal(root);
      for (const entry of sweep.entries) {
        const fields = { dbPath: entry.dbPath, walBytes: entry.walBytes, detail: entry.detail };
        if (entry.action === "converted") {
          logger.info("converted akm SQLite store out of WAL mode for container access", fields);
        } else if (entry.action === "orphaned-wal") {
          logger.warn("orphaned SQLite -wal sidecar under akm data root (left in place)", fields);
        } else {
          logger.warn(
            "could not convert akm SQLite store out of WAL mode; the in-container akm may fail to open it",
            fields,
          );
        }
      }
      results.push(sweep);
    } catch (error) {
      // convertWalDbsToDeleteJournal is written not to throw; this is the
      // never-break-applyHomeAssets backstop.
      logger.warn("akm SQLite WAL sweep failed", { root, error: errMessage(error) });
    }
  }
  return results;
}
