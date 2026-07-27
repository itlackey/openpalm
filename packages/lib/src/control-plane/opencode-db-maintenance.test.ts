import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointWal,
  computeRetentionPlan,
  getDbSizeInfo,
  listSessionsPaged,
  resolveOpenCodeDbPath,
  runOpenCodeDbMaintenance,
  shouldVacuum,
  toSessionRecord,
  vacuumDb,
  type RunMaintenanceOptions,
  type SessionDeletionClient,
  type SessionRecord,
} from "./opencode-db-maintenance.js";
import type { OpenCodeSession } from "./opencode-client.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-26T00:00:00.000Z");

function rec(id: string, opts: Partial<SessionRecord> & { ageDays: number; archived?: boolean }): SessionRecord {
  const updatedAt = NOW - opts.ageDays * DAY_MS;
  return {
    id,
    parentID: opts.parentID,
    createdAt: opts.createdAt ?? updatedAt,
    updatedAt,
    ...(opts.archived ? { archivedAt: updatedAt } : {}),
  };
}

// ── computeRetentionPlan ─────────────────────────────────────────────────────

describe("computeRetentionPlan", () => {
  test("preserves recent root sessions unconditionally", () => {
    const sessions: SessionRecord[] = [rec("root-recent", { ageDays: 0.1 })];
    const plan = computeRetentionPlan(sessions, { now: NOW, maxChildAgeMs: DAY_MS });
    expect(plan.preservedRootIds).toEqual(["root-recent"]);
    expect(plan.deleteSessionIds).toEqual([]);
  });

  test("never deletes a root session even when it is old and archived", () => {
    // A root itself is never stale-eligible, regardless of age or archived state.
    const sessions: SessionRecord[] = [rec("root-old", { ageDays: 400, archived: true })];
    const plan = computeRetentionPlan(sessions, { now: NOW, maxChildAgeMs: DAY_MS, requireArchived: true });
    expect(plan.deleteSessionIds).toEqual([]);
    expect(plan.preservedRootIds).toEqual(["root-old"]);
  });

  test("deletes a stale archived child tree, including a recently-updated grandchild (no orphans)", () => {
    const sessions: SessionRecord[] = [
      rec("root", { ageDays: 1 }),
      rec("child-stale", { ageDays: 90, archived: true, parentID: "root" }),
      // grandchild is individually "recent" but must still be swept — its
      // parent is being deleted, so leaving it behind would orphan it.
      rec("grandchild-recent", { ageDays: 0.1, archived: false, parentID: "child-stale" }),
    ];
    const plan = computeRetentionPlan(sessions, { now: NOW, maxChildAgeMs: 30 * DAY_MS });

    expect(plan.preservedRootIds).toEqual(["root"]);
    expect(new Set(plan.deleteSessionIds)).toEqual(new Set(["child-stale", "grandchild-recent"]));
    // Deepest-first delete order: grandchild before its parent.
    expect(plan.deleteSessionIds.indexOf("grandchild-recent")).toBeLessThan(plan.deleteSessionIds.indexOf("child-stale"));
    expect(plan.preservedChildIds).toEqual([]);
  });

  test("keeps a stale child that is not archived (requireArchived default true is conservative)", () => {
    const sessions: SessionRecord[] = [
      rec("root", { ageDays: 1 }),
      rec("child-stale-unarchived", { ageDays: 90, archived: false, parentID: "root" }),
    ];
    const plan = computeRetentionPlan(sessions, { now: NOW, maxChildAgeMs: 30 * DAY_MS });
    expect(plan.deleteSessionIds).toEqual([]);
    expect(plan.preservedChildIds).toEqual(["child-stale-unarchived"]);
  });

  test("requireArchived: false allows deleting a stale-but-unarchived child", () => {
    const sessions: SessionRecord[] = [
      rec("root", { ageDays: 1 }),
      rec("child-stale-unarchived", { ageDays: 90, archived: false, parentID: "root" }),
    ];
    const plan = computeRetentionPlan(sessions, { now: NOW, maxChildAgeMs: 30 * DAY_MS, requireArchived: false });
    expect(plan.deleteSessionIds).toEqual(["child-stale-unarchived"]);
  });

  test("keeps a recently-updated archived child (not old enough yet)", () => {
    const sessions: SessionRecord[] = [
      rec("root", { ageDays: 1 }),
      rec("child-recent-archived", { ageDays: 1, archived: true, parentID: "root" }),
    ];
    const plan = computeRetentionPlan(sessions, { now: NOW, maxChildAgeMs: 30 * DAY_MS });
    expect(plan.deleteSessionIds).toEqual([]);
    expect(plan.preservedChildIds).toEqual(["child-recent-archived"]);
  });

  test("a dangling parentID (parent not present) is treated as its own root, not swept as a child", () => {
    const sessions: SessionRecord[] = [rec("orphaned-child", { ageDays: 400, archived: true, parentID: "missing-parent" })];
    const plan = computeRetentionPlan(sessions, { now: NOW, maxChildAgeMs: DAY_MS });
    expect(plan.rootCount).toBe(1);
    expect(plan.preservedRootIds).toEqual(["orphaned-child"]);
    expect(plan.deleteSessionIds).toEqual([]);
  });

  test("maxTotalSessions caps total count by deleting additional oldest child sessions beyond age-based selection", () => {
    const sessions: SessionRecord[] = [
      rec("root", { ageDays: 0.1 }),
      // Below age threshold individually, but there are 3 children + 1 root = 4 sessions.
      rec("child-1", { ageDays: 5, archived: true, parentID: "root" }),
      rec("child-2", { ageDays: 4, archived: true, parentID: "root" }),
      rec("child-3", { ageDays: 3, archived: true, parentID: "root" }),
    ];
    const plan = computeRetentionPlan(sessions, {
      now: NOW,
      maxChildAgeMs: 30 * DAY_MS, // nothing is age-stale
      maxTotalSessions: 2, // but cap total sessions at 2 (root + 1 child)
    });
    // Root is always preserved, so only children can be trimmed to hit the cap.
    expect(plan.preservedRootIds).toEqual(["root"]);
    expect(plan.deleteSessionIds).toHaveLength(2);
    // Oldest children (child-1, child-2) go first; child-3 (newest) survives.
    expect(plan.deleteSessionIds).toContain("child-1");
    expect(plan.deleteSessionIds).toContain("child-2");
    expect(plan.deleteSessionIds).not.toContain("child-3");
  });

  test("maxTotalSessions never deletes a root to hit the cap", () => {
    const sessions: SessionRecord[] = [
      rec("root-1", { ageDays: 10 }),
      rec("root-2", { ageDays: 5 }),
      rec("root-3", { ageDays: 1 }),
    ];
    const plan = computeRetentionPlan(sessions, { now: NOW, maxChildAgeMs: DAY_MS, maxTotalSessions: 1 });
    expect(plan.deleteSessionIds).toEqual([]);
    expect(plan.preservedRootIds).toHaveLength(3);
  });

  test("toSessionRecord adapts an OpenCodeSession (live API shape) correctly", () => {
    const session: OpenCodeSession = { id: "s1", parentID: "root", time: { created: 1, updated: 2, archived: 3 } };
    expect(toSessionRecord(session)).toEqual({ id: "s1", parentID: "root", createdAt: 1, updatedAt: 2, archivedAt: 3 });
  });

  test("toSessionRecord falls back updatedAt to createdAt when time.updated is absent", () => {
    const session: OpenCodeSession = { id: "s1", time: { created: 5, updated: undefined as unknown as number } };
    expect(toSessionRecord(session).updatedAt).toBe(5);
  });
});

// ── listSessionsPaged ────────────────────────────────────────────────────────

describe("listSessionsPaged", () => {
  const sessions: SessionRecord[] = [
    rec("root", { ageDays: 10 }),
    rec("child-a", { ageDays: 20, parentID: "root" }),
    rec("child-b", { ageDays: 5, parentID: "root" }),
    rec("grandchild", { ageDays: 1, parentID: "child-a" }),
  ];

  test("sorts oldest-updated first and reports depth/parentID", () => {
    const page = listSessionsPaged(sessions, { now: NOW, pageSize: 10 });
    expect(page.totalSessions).toBe(4);
    expect(page.rows.map((r) => r.id)).toEqual(["child-a", "root", "child-b", "grandchild"]);
    expect(page.rows.find((r) => r.id === "grandchild")?.depth).toBe(2);
    expect(page.rows.find((r) => r.id === "child-a")?.parentID).toBe("root");
    expect(page.summary.rootCount).toBe(1);
    expect(page.summary.maxDepth).toBe(2);
  });

  test("paginates correctly", () => {
    const page1 = listSessionsPaged(sessions, { now: NOW, page: 1, pageSize: 2 });
    const page2 = listSessionsPaged(sessions, { now: NOW, page: 2, pageSize: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(2);
    expect(page1.totalPages).toBe(2);
    expect(new Set([...page1.rows, ...page2.rows].map((r) => r.id))).toEqual(new Set(sessions.map((s) => s.id)));
  });

  test("estimatedPayloadBytes is an equal average share of totalDbBytes", () => {
    const page = listSessionsPaged(sessions, { now: NOW, totalDbBytes: 4000 });
    expect(page.rows.every((r) => r.estimatedPayloadBytes === 1000)).toBe(true);
  });

  test("estimatedPayloadBytes is 0 when totalDbBytes is not supplied", () => {
    const page = listSessionsPaged(sessions, { now: NOW });
    expect(page.rows.every((r) => r.estimatedPayloadBytes === 0)).toBe(true);
  });

  test("staleCount reflects staleAgeMs against depth>0 nodes only", () => {
    const page = listSessionsPaged(sessions, { now: NOW, staleAgeMs: 15 * DAY_MS });
    // child-a (20d) is the only depth>0 node older than 15 days.
    expect(page.summary.staleCount).toBe(1);
  });
});

// ── Direct sqlite file maintenance (checkpoint / VACUUM / size accounting) ──

describe("sqlite file maintenance (real temp-file DB)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openpalm-oc-db-maint-"));
    dbPath = join(dir, "opencode.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Seed a synthetic session-shaped table with bulky payloads, then delete
   * most of it — mirrors the incident's "deletion frees pages logically, but
   * the file doesn't shrink until VACUUM" shape. This table's schema is a
   * test fixture ONLY, not a claim about OpenCode's real on-disk schema —
   * this module never reads/writes session rows directly (see module doc).
   */
  function seedFixtureDb(): void {
    const db = new Database(dbPath, { create: true });
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, updated_at INTEGER, payload BLOB);");
      const insert = db.prepare("INSERT INTO session (id, parent_id, updated_at, payload) VALUES (?, ?, ?, ?)");
      const bigPayload = "x".repeat(50_000);
      for (let i = 0; i < 200; i++) {
        insert.run(`s${i}`, i === 0 ? null : "s0", NOW - i * 1000, bigPayload);
      }
      // Delete almost everything — logical deletion, page reuse doesn't
      // shrink the file until VACUUM.
      db.exec("DELETE FROM session WHERE id <> 's0';");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      db.close();
    }
  }

  test("getDbSizeInfo reports a nonzero freelist after bulk deletion", () => {
    seedFixtureDb();
    const info = getDbSizeInfo(dbPath);
    expect(info.pageCount).toBeGreaterThan(0);
    expect(info.freelistCount).toBeGreaterThan(0);
    expect(info.freeRatio).toBeGreaterThan(0);
  });

  test("shouldVacuum is true for a DB with a large reclaimable freelist, false for a fresh tiny DB", () => {
    seedFixtureDb();
    const dirty = getDbSizeInfo(dbPath);
    expect(shouldVacuum(dirty)).toBe(true);

    const freshPath = join(dir, "fresh.db");
    const fresh = new Database(freshPath, { create: true });
    fresh.exec("CREATE TABLE t (x INTEGER);");
    fresh.close();
    expect(shouldVacuum(getDbSizeInfo(freshPath))).toBe(false);
  });

  test("checkpointWal truncates the -wal file", () => {
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("CREATE TABLE t (x INTEGER);");
    const insert = db.prepare("INSERT INTO t (x) VALUES (?)");
    for (let i = 0; i < 500; i++) insert.run(i);
    db.close();

    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    const walSizeBefore = statSync(`${dbPath}-wal`).size;
    checkpointWal(dbPath, "TRUNCATE");
    const walSizeAfter = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
    expect(walSizeAfter).toBeLessThanOrEqual(walSizeBefore);
  });

  test("VACUUM shrinks the file size after bulk deletion (the incident's core evidence)", () => {
    seedFixtureDb();
    const sizeBefore = statSync(dbPath).size;
    const infoBefore = getDbSizeInfo(dbPath);
    expect(infoBefore.freelistCount).toBeGreaterThan(0);

    vacuumDb(dbPath);

    const sizeAfter = statSync(dbPath).size;
    const infoAfter = getDbSizeInfo(dbPath);
    expect(sizeAfter).toBeLessThan(sizeBefore);
    expect(infoAfter.freelistCount).toBe(0);
  });

  test("resolveOpenCodeDbPath matches storage-report.ts's OPENCODE_STORE_RELATIVE_PATHS convention", () => {
    expect(resolveOpenCodeDbPath("/op/home", "assistant")).toBe("/op/home/data/assistant/.local/share/opencode/opencode.db");
    expect(resolveOpenCodeDbPath("/op/home", "guardian")).toBe("/op/home/data/guardian/.local/share/opencode/opencode.db");
  });
});

// ── runOpenCodeDbMaintenance (orchestration, mock client + real temp DB) ────

describe("runOpenCodeDbMaintenance", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openpalm-oc-db-run-"));
    dbPath = join(dir, "opencode.db");
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("CREATE TABLE t (x BLOB);");
    const insert = db.prepare("INSERT INTO t (x) VALUES (?)");
    const blob = "y".repeat(50_000);
    for (let i = 0; i < 300; i++) insert.run(blob);
    db.exec("DELETE FROM t WHERE rowid > 1;");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeClient(sessions: OpenCodeSession[], deleteResults?: Record<string, boolean>): SessionDeletionClient & { deletedIds: string[] } {
    const deletedIds: string[] = [];
    return {
      deletedIds,
      async listSessions() {
        return sessions;
      },
      async deleteSession(id: string) {
        deletedIds.push(id);
        const ok = deleteResults?.[id] ?? true;
        return ok ? { ok: true } : { ok: false, message: "boom" };
      },
    };
  }

  const baseSessions: OpenCodeSession[] = [
    { id: "root", time: { created: NOW - 1 * DAY_MS, updated: NOW - 0.1 * DAY_MS } },
    { id: "stale-child", parentID: "root", time: { created: NOW - 90 * DAY_MS, updated: NOW - 90 * DAY_MS, archived: NOW - 90 * DAY_MS } },
  ];

  test("throws without confirm: true", async () => {
    const client = makeClient(baseSessions);
    await expect(
      runOpenCodeDbMaintenance(client, dbPath, { confirm: false, retention: { now: NOW, maxChildAgeMs: 30 * DAY_MS } } as RunMaintenanceOptions),
    ).rejects.toThrow(/confirm/);
  });

  test("dry run computes the plan and reports size but deletes/vacuums nothing", async () => {
    const client = makeClient(baseSessions);
    const result = await runOpenCodeDbMaintenance(client, dbPath, {
      confirm: true,
      dryRun: true,
      retention: { now: NOW, maxChildAgeMs: 30 * DAY_MS },
    });
    expect(result.plan.deleteSessionIds).toEqual(["stale-child"]);
    expect(result.deleted).toEqual([]);
    expect(client.deletedIds).toEqual([]);
    expect(result.checkpointed).toBe(false);
    expect(result.vacuumed).toBe(false);
    expect(result.sizeBefore).toBeDefined();
  });

  test("live run deletes stale children via the client, checkpoints, and vacuums when thresholds are met", async () => {
    const client = makeClient(baseSessions);
    const sizeBeforeRaw = statSync(dbPath).size;

    const result = await runOpenCodeDbMaintenance(client, dbPath, {
      confirm: true,
      retention: { now: NOW, maxChildAgeMs: 30 * DAY_MS },
      vacuumThresholds: { minDbBytes: 0, minFreeRatio: 0, minFreeBytes: 0 }, // force vacuum for this test
    });

    expect(client.deletedIds).toEqual(["stale-child"]);
    expect(result.deleted).toEqual(["stale-child"]);
    expect(result.deleteFailures).toEqual([]);
    expect(result.checkpointed).toBe(true);
    expect(result.vacuumed).toBe(true);
    expect(result.sizeAfter).toBeDefined();
    expect(result.sizeAfter?.freelistCount).toBe(0);

    const sizeAfterRaw = statSync(dbPath).size;
    expect(sizeAfterRaw).toBeLessThan(sizeBeforeRaw);
  });

  test("never selects the root session for deletion even in a live run", async () => {
    const client = makeClient(baseSessions);
    await runOpenCodeDbMaintenance(client, dbPath, {
      confirm: true,
      retention: { now: NOW, maxChildAgeMs: 30 * DAY_MS },
      skipVacuumStage: true,
    });
    expect(client.deletedIds).not.toContain("root");
  });

  test("records per-session delete failures without throwing", async () => {
    const client = makeClient(baseSessions, { "stale-child": false });
    const result = await runOpenCodeDbMaintenance(client, dbPath, {
      confirm: true,
      retention: { now: NOW, maxChildAgeMs: 30 * DAY_MS },
      skipVacuumStage: true,
    });
    expect(result.deleted).toEqual([]);
    expect(result.deleteFailures).toEqual([{ id: "stale-child", message: "boom" }]);
  });

  test("skipVacuumStage skips checkpoint/vacuum/size accounting entirely", async () => {
    const client = makeClient(baseSessions);
    const result = await runOpenCodeDbMaintenance(client, dbPath, {
      confirm: true,
      retention: { now: NOW, maxChildAgeMs: 30 * DAY_MS },
      skipVacuumStage: true,
    });
    expect(result.checkpointed).toBe(false);
    expect(result.vacuumed).toBe(false);
    expect(result.sizeBefore).toBeUndefined();
    expect(result.sizeAfter).toBeUndefined();
  });
});
