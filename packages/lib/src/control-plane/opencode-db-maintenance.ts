/**
 * OpenCode session/DB maintenance (S3 — #581 finding #5).
 *
 * The assistant's OpenCode store (`opencode.db` + `-wal`/`-shm`) is durable
 * home state with **no** built-in age/count retention, event pruning, WAL
 * checkpointing, or `VACUUM`. In the "krang" incident, supported API deletion
 * freed 353,448 pages *logically* but the file stayed 1.4 GB until an
 * explicit `VACUUM` cut it to 16 MB — deletion alone does not reclaim disk.
 *
 * This module is a callable lib surface for `openpalm doctor`/CLI use. It is
 * NOT wired into any boot path, cron, or default flow — running maintenance
 * here is always an explicit, opt-in call by a caller that passes
 * `confirm: true`. Nothing here runs automatically.
 *
 * Two distinct integration boundaries, kept separate deliberately:
 *
 *  1. Session **deletion** goes through OpenCode's supported
 *     `DELETE /session/{id}` REST endpoint (`opencode-client.ts`) — never raw
 *     SQL against a live DB, since the on-disk schema is internal and
 *     undocumented. The retention *decision* (which sessions are stale) is a
 *     pure function over the same `Session` shape OpenCode's REST API
 *     returns (`id`, `parentID`, `time.created/updated/archived`) — no
 *     knowledge of table/column names required.
 *
 *  2. WAL **checkpoint** and **VACUUM** operate directly on the sqlite file
 *     via `bun:sqlite`. These are generic sqlite maintenance operations
 *     (`PRAGMA wal_checkpoint`, `VACUUM`, `PRAGMA page_count`/`freelist_count`)
 *     that need no knowledge of OpenCode's table schema at all, so they carry
 *     no schema-assumption risk the way raw session deletion would.
 *
 * Retention policy (conservative by construction, not just by default):
 * root sessions (no `parentID`) are **never** selected for deletion by this
 * module — only descendant ("child tree") sessions can be. This preserves
 * "active/recent root sessions" unconditionally and targets exactly the
 * stale subagent/child trees the incident report calls out, without
 * restricting subagent use going forward.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { OpenCodeSession } from "./opencode-client.js";

// `bun:sqlite` is a Bun built-in and this module only ever runs under the Bun
// CLI. But it is re-exported from the @openpalm/lib barrel, which Node/Vitest
// consumers (ui, electron) import — a static value import of `bun:sqlite` would
// make the whole barrel unloadable under Node (ERR_MODULE_NOT_FOUND). Keep the
// type import (erased at runtime) and resolve the constructor lazily, so
// importing this module under Node never touches `bun:sqlite`; only actually
// calling one of the DB functions (which happens under Bun) resolves it.
const requireBun = createRequire(import.meta.url);
let cachedDatabaseCtor: typeof Database | undefined;
function loadDatabase(): typeof Database {
  cachedDatabaseCtor ??= (requireBun("bun:sqlite") as typeof import("bun:sqlite")).Database;
  return cachedDatabaseCtor;
}

// ── Session retention (pure — no I/O) ───────────────────────────────────────

/** Minimal session shape the retention logic needs — a structural subset of {@link OpenCodeSession}. */
export interface SessionRecord {
  id: string;
  parentID?: string;
  createdAt: number;
  updatedAt: number;
  /** Present once OpenCode marks a session archived/completed; absent for live/open sessions. */
  archivedAt?: number;
}

/** Adapt a live `GET /session` row (see `opencode-client.ts`) into a {@link SessionRecord}. */
export function toSessionRecord(session: OpenCodeSession): SessionRecord {
  return {
    id: session.id,
    parentID: session.parentID,
    createdAt: session.time?.created ?? 0,
    updatedAt: session.time?.updated ?? session.time?.created ?? 0,
    ...(session.time?.archived !== undefined ? { archivedAt: session.time.archived } : {}),
  };
}

export interface RetentionOptions {
  /** Epoch ms "now" reference — defaults to `Date.now()`. Pass explicitly in tests for determinism. */
  now?: number;
  /**
   * Child (non-root) sessions whose `updatedAt` is older than `now - maxChildAgeMs`
   * are stale-eligible. Required — there is no implicit default age, so a
   * caller must consciously choose a retention window.
   */
  maxChildAgeMs: number;
  /**
   * When true (default), only child sessions with `archivedAt` set are
   * eligible for deletion, even if stale by age — an open/live session is
   * never deleted purely for being old. Conservative default; set false only
   * if the caller has independently confirmed "archived" isn't a reliable
   * completion signal for the OpenCode version in use.
   */
  requireArchived?: boolean;
  /**
   * Optional hard cap on total session count. Applied AFTER age-based
   * selection: if the tree still exceeds this count, additional child
   * sessions (never roots) are selected for deletion oldest-`updatedAt`-first
   * until the cap is met. Omit for age-only retention (the conservative
   * default — no count cap unless explicitly requested).
   */
  maxTotalSessions?: number;
}

export interface RetentionPlan {
  totalSessions: number;
  rootCount: number;
  /** Root session ids — always preserved by this module; never appears in `deleteSessionIds`. */
  preservedRootIds: string[];
  /** Child session ids selected for deletion, ordered deepest-first (safe delete order: leaves before ancestors). */
  deleteSessionIds: string[];
  /** Child session ids NOT selected for deletion (recent, not archived, or protected by tree consistency). */
  preservedChildIds: string[];
}

interface GraphNode {
  record: SessionRecord;
  depth: number;
  children: string[];
}

/** Build id→node map + depth, treating any session whose `parentID` doesn't resolve to another known session as a root (defensive: an orphaned/dangling parentID must never be treated as "definitely a child" and get swept up). */
function buildGraph(sessions: SessionRecord[]): { nodes: Map<string, GraphNode>; roots: string[] } {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const nodes = new Map<string, GraphNode>();
  for (const s of sessions) {
    const hasKnownParent = s.parentID !== undefined && byId.has(s.parentID);
    nodes.set(s.id, { record: s, depth: hasKnownParent ? -1 : 0, children: [] });
  }
  for (const s of sessions) {
    const hasKnownParent = s.parentID !== undefined && byId.has(s.parentID) && s.parentID !== s.id;
    if (hasKnownParent) {
      nodes.get(s.parentID as string)?.children.push(s.id);
    }
  }
  const roots = [...nodes.values()].filter((n) => n.depth === 0).map((n) => n.record.id);

  // BFS to assign depth to every reachable descendant (roots are depth 0).
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const node = nodes.get(id);
    if (!node) continue;
    for (const childId of node.children) {
      const child = nodes.get(childId);
      if (child && child.depth === -1) {
        child.depth = node.depth + 1;
        queue.push(childId);
      }
    }
  }
  // Any node still at depth -1 is part of a parentID cycle (should not happen
  // in practice, but a malformed/adversarial dataset must not crash retention
  // planning) — treat as its own root defensively rather than leaving it
  // unclassified.
  for (const node of nodes.values()) {
    if (node.depth === -1) {
      node.depth = 0;
      roots.push(node.record.id);
    }
  }
  return { nodes, roots };
}

/**
 * Decide which child (non-root) sessions are safe to delete, given an age
 * window and an optional total-count cap. Roots are never selected. Pure
 * function — no filesystem or network access — so it is fully unit-testable
 * against a synthetic session list.
 */
export function computeRetentionPlan(sessions: SessionRecord[], options: RetentionOptions): RetentionPlan {
  const now = options.now ?? Date.now();
  const requireArchived = options.requireArchived ?? true;
  const { nodes, roots } = buildGraph(sessions);
  const rootSet = new Set(roots);

  const isStale = (n: GraphNode): boolean => {
    if (n.depth === 0) return false; // roots are never stale-eligible
    if (requireArchived && n.record.archivedAt === undefined) return false;
    return n.record.updatedAt < now - options.maxChildAgeMs;
  };

  // Minimal stale subtree roots: a stale node whose parent is NOT itself
  // stale (or is a root) — deleting from there sweeps the whole descendant
  // subtree too, so no child is ever orphaned by deleting only its parent.
  const toDelete = new Set<string>();
  const markSubtree = (id: string): void => {
    if (toDelete.has(id)) return;
    toDelete.add(id);
    const node = nodes.get(id);
    if (!node) return;
    for (const childId of node.children) markSubtree(childId);
  };

  for (const node of nodes.values()) {
    if (node.depth === 0) continue;
    const parentId = node.record.parentID;
    const parentNode = parentId !== undefined ? nodes.get(parentId) : undefined;
    const parentIsStaleSubtreeRoot = parentNode ? isStale(parentNode) : false;
    if (isStale(node) && !parentIsStaleSubtreeRoot) {
      markSubtree(node.record.id);
    }
  }

  // Optional count cap: if still over budget after age-based selection,
  // delete additional (non-root, not-already-selected) sessions oldest-first.
  if (options.maxTotalSessions !== undefined) {
    const survivingCount = sessions.length - toDelete.size;
    let overBudget = survivingCount - options.maxTotalSessions;
    if (overBudget > 0) {
      const candidates = [...nodes.values()]
        .filter((n) => n.depth > 0 && !toDelete.has(n.record.id))
        .sort((a, b) => a.record.updatedAt - b.record.updatedAt);
      for (const candidate of candidates) {
        if (overBudget <= 0) break;
        const before = toDelete.size;
        markSubtree(candidate.record.id);
        overBudget -= toDelete.size - before;
      }
    }
  }

  // Deepest-first ordering (descending depth) — safe delete order in case a
  // caller's deletion API cares about children-before-ancestors.
  const deleteSessionIds = [...toDelete]
    .map((id) => nodes.get(id))
    .filter((n): n is GraphNode => n !== undefined)
    .sort((a, b) => b.depth - a.depth)
    .map((n) => n.record.id);

  const preservedChildIds = sessions
    .map((s) => s.id)
    .filter((id) => !rootSet.has(id) && !toDelete.has(id));

  return {
    totalSessions: sessions.length,
    rootCount: roots.length,
    preservedRootIds: roots,
    deleteSessionIds,
    preservedChildIds,
  };
}

// ── Bulk / paginated visibility surface ─────────────────────────────────────

export interface SessionVisibilityRow {
  id: string;
  parentID?: string;
  depth: number;
  ageMs: number;
  archived: boolean;
  /** Rough average-share estimate in bytes: `totalDbBytes / totalSessions`, or 0 when `totalDbBytes` is not supplied. Not a per-session measurement — OpenCode's REST API exposes no per-session byte size. */
  estimatedPayloadBytes: number;
}

export interface SessionVisibilityPage {
  page: number;
  pageSize: number;
  totalSessions: number;
  totalPages: number;
  rows: SessionVisibilityRow[];
  summary: {
    rootCount: number;
    maxDepth: number;
    staleCount: number;
  };
}

export interface SessionVisibilityOptions {
  now?: number;
  page?: number;
  pageSize?: number;
  /** Same age window used to flag `stale` in the summary — purely informational here, no deletion. */
  staleAgeMs?: number;
  /** Total OpenCode DB file size in bytes, used only to compute `estimatedPayloadBytes`'s average-share estimate. */
  totalDbBytes?: number;
}

const DEFAULT_PAGE_SIZE = 100;

/**
 * Build a paginated, sorted (oldest-`updatedAt`-first) visibility view over a
 * session list — counts, `parentID`, tree depth, age, and a rough payload
 * estimate — for `openpalm doctor`/CLI consumption. Read-only; makes no
 * deletion decisions (see {@link computeRetentionPlan} for that).
 */
export function listSessionsPaged(sessions: SessionRecord[], options: SessionVisibilityOptions = {}): SessionVisibilityPage {
  const now = options.now ?? Date.now();
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
  const staleAgeMs = options.staleAgeMs ?? Number.POSITIVE_INFINITY;
  const totalDbBytes = options.totalDbBytes ?? 0;

  const { nodes } = buildGraph(sessions);
  const perSessionBytes = sessions.length > 0 ? totalDbBytes / sessions.length : 0;

  const sorted = [...nodes.values()].sort((a, b) => a.record.updatedAt - b.record.updatedAt);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageNodes = sorted.slice(start, start + pageSize);

  const rows: SessionVisibilityRow[] = pageNodes.map((n) => ({
    id: n.record.id,
    parentID: n.record.parentID,
    depth: n.depth,
    ageMs: Math.max(0, now - n.record.updatedAt),
    archived: n.record.archivedAt !== undefined,
    estimatedPayloadBytes: Math.round(perSessionBytes),
  }));

  const maxDepth = sorted.reduce((max, n) => Math.max(max, n.depth), 0);
  const rootCount = sorted.filter((n) => n.depth === 0).length;
  const staleCount = sorted.filter((n) => n.depth > 0 && now - n.record.updatedAt > staleAgeMs).length;

  return {
    page,
    pageSize,
    totalSessions: sorted.length,
    totalPages,
    rows,
    summary: { rootCount, maxDepth, staleCount },
  };
}

// ── Direct sqlite file maintenance (checkpoint / VACUUM / size accounting) ──

export interface DbSizeInfo {
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  /** `pageCount * pageSize` — the DB's logical page-allocated size (close to, but not always identical to, the file's byte size on disk). */
  fileBytes: number;
  /** `freelistCount * pageSize` — space `VACUUM` would reclaim. */
  freeBytes: number;
  /** `freeBytes / fileBytes`, or 0 when `fileBytes` is 0. */
  freeRatio: number;
}

function pragmaNumber(db: Database, pragma: string, column: string): number {
  const row = db.query(`PRAGMA ${pragma};`).get() as Record<string, unknown> | null;
  const value = row?.[column];
  return typeof value === "number" ? value : 0;
}

/** Read page/freelist accounting from a sqlite file without locking it for writes. */
export function getDbSizeInfo(dbPath: string): DbSizeInfo {
  const db = new (loadDatabase())(dbPath, { readonly: true });
  try {
    const pageCount = pragmaNumber(db, "page_count", "page_count");
    const pageSize = pragmaNumber(db, "page_size", "page_size");
    const freelistCount = pragmaNumber(db, "freelist_count", "freelist_count");
    const fileBytes = pageCount * pageSize;
    const freeBytes = freelistCount * pageSize;
    return {
      pageCount,
      pageSize,
      freelistCount,
      fileBytes,
      freeBytes,
      freeRatio: fileBytes > 0 ? freeBytes / fileBytes : 0,
    };
  } finally {
    db.close();
  }
}

export type WalCheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";

/**
 * Checkpoint the WAL file into the main DB. `TRUNCATE` (the default) also
 * truncates the `-wal` file back to zero bytes on success — the mode this
 * module wants before measuring/vacuuming, so WAL growth doesn't masquerade
 * as "the DB isn't the problem."
 */
export function checkpointWal(dbPath: string, mode: WalCheckpointMode = "TRUNCATE"): void {
  const db = new (loadDatabase())(dbPath);
  try {
    db.exec(`PRAGMA wal_checkpoint(${mode});`);
  } finally {
    db.close();
  }
}

/**
 * Rebuild the database file, reclaiming freelist pages. Exclusive-locks the
 * DB for the duration — never call this against a DB a live OpenCode server
 * has open without expecting contention.
 *
 * In WAL journal mode (OpenCode's default), `VACUUM`'s rewritten pages land
 * in the `-wal` file, not the main DB file — the main file does NOT shrink
 * until a checkpoint replays the WAL back in. Confirmed empirically in this
 * environment: `VACUUM` alone left `page_count` small but the on-disk file
 * unchanged; adding `PRAGMA wal_checkpoint(TRUNCATE)` right after, in the same
 * connection, is what actually shrinks the file. So this always checkpoints
 * immediately after vacuuming, in the same connection/transaction scope.
 */
export function vacuumDb(dbPath: string): void {
  const db = new (loadDatabase())(dbPath);
  try {
    db.exec("VACUUM;");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
}

export interface VacuumThresholds {
  /** Vacuum when `freeRatio` is at least this fraction (0..1). Default 0.2 (20% reclaimable). */
  minFreeRatio?: number;
  /** Vacuum when `freeBytes` is at least this many bytes, regardless of ratio. Default 50 MiB. */
  minFreeBytes?: number;
  /** Never vacuum a DB smaller than this — not worth the exclusive lock. Default 8 MiB. */
  minDbBytes?: number;
}

const DEFAULT_VACUUM_THRESHOLDS: Required<VacuumThresholds> = {
  minFreeRatio: 0.2,
  minFreeBytes: 50 * 1024 * 1024,
  minDbBytes: 8 * 1024 * 1024,
};

/** Decide whether `info` justifies a `VACUUM`, per the "deletion alone does not reclaim disk" finding — checked against BOTH a free-ratio floor and an absolute-bytes floor so a huge-but-sparse DB and a smaller-but-heavily-fragmented DB both trigger correctly. */
export function shouldVacuum(info: DbSizeInfo, thresholds: VacuumThresholds = {}): boolean {
  const t = { ...DEFAULT_VACUUM_THRESHOLDS, ...thresholds };
  if (info.fileBytes < t.minDbBytes) return false;
  return info.freeRatio >= t.minFreeRatio || info.freeBytes >= t.minFreeBytes;
}

// ── Orchestration ────────────────────────────────────────────────────────────

/** Narrow client contract this module needs — matches `createOpenCodeClient()`'s return shape without importing its concrete type, so a test double doesn't have to implement every client method. */
export interface SessionDeletionClient {
  listSessions(): Promise<OpenCodeSession[]>;
  deleteSession(sessionId: string): Promise<{ ok: boolean; message?: string }>;
}

export interface RunMaintenanceOptions {
  /** Required — refuses to delete or vacuum anything unless explicitly true. Mirrors `cleanCaches`'s `confirm` gate (storage-report.ts) for the same reason: this is destructive. */
  confirm: boolean;
  /** Report what would happen without calling DELETE, checkpoint, or VACUUM. */
  dryRun?: boolean;
  /**
   * Session-retention window. Required whenever a live `client` is supplied
   * (the caller must consciously choose which child sessions are stale).
   * Ignored — and may be omitted — for the file-only reclamation path
   * (`client === null`), where no sessions are listed or deleted.
   */
  retention?: RetentionOptions;
  vacuumThresholds?: VacuumThresholds;
  /** Skip the WAL-checkpoint/size/VACUUM stage entirely (e.g. caller only wants session pruning). */
  skipVacuumStage?: boolean;
}

/** An empty retention plan — used for the file-only reclamation path where no sessions are listed. */
function emptyRetentionPlan(): RetentionPlan {
  return { totalSessions: 0, rootCount: 0, preservedRootIds: [], deleteSessionIds: [], preservedChildIds: [] };
}

export interface RunMaintenanceResult {
  dryRun: boolean;
  plan: RetentionPlan;
  deleted: string[];
  deleteFailures: Array<{ id: string; message: string }>;
  sizeBefore?: DbSizeInfo;
  sizeAfter?: DbSizeInfo;
  checkpointed: boolean;
  vacuumed: boolean;
}

/**
 * Full maintenance pass: fetch live sessions → compute retention plan →
 * delete stale child sessions via the supported API → checkpoint the WAL →
 * measure → `VACUUM` if thresholds justify it → measure again.
 *
 * This composes already-unit-tested pieces ({@link computeRetentionPlan},
 * {@link checkpointWal}, {@link vacuumDb}, {@link shouldVacuum}); the
 * orchestration itself is exercised here with a mock client + a real temp-file
 * DB fixture, not a live OpenCode server — treat wiring against a real
 * assistant/guardian OpenCode instance as unverified until an image-build +
 * live-stack pass confirms `listSessions`/`deleteSession` behave as this
 * module assumes.
 *
 * `client` may be `null` for the **file-only reclamation** path: skip the
 * session-listing/deletion stage entirely and go straight to
 * checkpoint/measure/`VACUUM`. This is the path `openpalm doctor --reclaim-db`
 * uses, because the two stages have opposite preconditions — a live REST
 * session-delete needs the assistant *running*, but a safe `VACUUM` needs it
 * *stopped* (no concurrent writer). Disk reclamation on the on-disk DB is the
 * part that actually addresses the S3 "1.4 GB → 16 MB after VACUUM" incident.
 */
export async function runOpenCodeDbMaintenance(
  client: SessionDeletionClient | null,
  dbPath: string,
  options: RunMaintenanceOptions,
): Promise<RunMaintenanceResult> {
  if (!options.confirm) {
    throw new Error("runOpenCodeDbMaintenance refuses to run without confirm: true.");
  }
  const dryRun = !!options.dryRun;

  let plan: RetentionPlan;
  const deleted: string[] = [];
  const deleteFailures: Array<{ id: string; message: string }> = [];
  if (client) {
    if (!options.retention) {
      throw new Error("runOpenCodeDbMaintenance requires a retention window when a client is supplied.");
    }
    const sessions = (await client.listSessions()).map(toSessionRecord);
    plan = computeRetentionPlan(sessions, options.retention);
    if (!dryRun) {
      for (const id of plan.deleteSessionIds) {
        const result = await client.deleteSession(id);
        if (result.ok) {
          deleted.push(id);
        } else {
          deleteFailures.push({ id, message: result.message ?? "delete failed" });
        }
      }
    }
  } else {
    // File-only reclamation: no live server to list/delete sessions against.
    plan = emptyRetentionPlan();
  }

  if (options.skipVacuumStage) {
    return { dryRun, plan, deleted, deleteFailures, checkpointed: false, vacuumed: false };
  }

  if (dryRun) {
    const sizeBefore = getDbSizeInfo(dbPath);
    return { dryRun, plan, deleted, deleteFailures, sizeBefore, checkpointed: false, vacuumed: false };
  }

  checkpointWal(dbPath, "TRUNCATE");
  const sizeBefore = getDbSizeInfo(dbPath);
  let vacuumed = false;
  let sizeAfter = sizeBefore;
  if (shouldVacuum(sizeBefore, options.vacuumThresholds)) {
    vacuumDb(dbPath);
    vacuumed = true;
    sizeAfter = getDbSizeInfo(dbPath);
  }

  return { dryRun, plan, deleted, deleteFailures, sizeBefore, sizeAfter, checkpointed: true, vacuumed };
}

/** `homeDir`-relative OpenCode DB path for `role`, mirroring `storage-report.ts`'s `OPENCODE_STORE_RELATIVE_PATHS` convention. */
export function resolveOpenCodeDbPath(homeDir: string, role: "assistant" | "guardian"): string {
  return join(homeDir, "data", role, ".local", "share", "opencode", "opencode.db");
}
