import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertWalDbsToDeleteJournal, reconcileAkmDbJournalMode } from "./akm-db-journal.js";
import { akmDataRoots } from "./home.js";
import type { HostRuntime } from "./host-identity.js";

const VM_RUNTIME: HostRuntime = {
  id: "vm-mediated-darwin",
  hostUidAuthoritative: false,
  bindMountsCrossVmFilesystem: true,
};
const LINUX_RUNTIME: HostRuntime = {
  id: "linux-native",
  hostUidAuthoritative: true,
  bindMountsCrossVmFilesystem: false,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "akm-db-journal-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** SQLite main-file header bytes 18/19: 1 = rollback journal, 2 = WAL. */
function headerVersions(path: string): [number, number] {
  const buf = readFileSync(path);
  return [buf[18] as number, buf[19] as number];
}

function countRows(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("SELECT count(*) AS n FROM t;").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/**
 * Build `<targetDir>/<name>` as a WAL-mode database whose rows live ONLY in
 * an un-checkpointed `-wal` sidecar — the shape a pre-0.9.6 in-container akm
 * leaves behind over virtiofs. The trio is copied while a connection is
 * still open, because closing the last connection auto-checkpoints and
 * deletes the `-wal`.
 */
function buildUncheckpointedWalDb(targetDir: string, name: string, rows: number): string {
  const workDir = mkdtempSync(join(tmpdir(), "walsrc-"));
  const srcPath = join(workDir, "src.db");
  const db = new Database(srcPath);
  try {
    // Create the table BEFORE switching to WAL so the main file has real
    // pages, then keep every subsequent commit in the WAL.
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA wal_autocheckpoint = 0;");
    db.exec("BEGIN;");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?);");
    for (let i = 0; i < rows; i++) insert.run(`row-${i}`);
    db.exec("COMMIT;");

    const target = join(targetDir, name);
    copyFileSync(srcPath, target);
    copyFileSync(`${srcPath}-wal`, `${target}-wal`);
    copyFileSync(`${srcPath}-shm`, `${target}-shm`);
    return target;
  } finally {
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

describe("convertWalDbsToDeleteJournal", () => {
  test("checkpoints an un-checkpointed WAL into the main file and flips to DELETE mode, losing no rows", () => {
    const dbPath = buildUncheckpointedWalDb(dir, "state.db", 250);
    // Fixture preconditions: the rows exist only in the sidecar.
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    const sweep = convertWalDbsToDeleteJournal(dir);

    expect(sweep.entries).toEqual([
      { dbPath, action: "converted", walBytes: expect.any(Number) },
    ]);
    expect(sweep.entries[0]?.walBytes).toBeGreaterThan(0);
    // SQLite removes the -wal on a successful journal-mode flip; the module
    // removes the stale -shm the departing connection leaves behind.
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(headerVersions(dbPath)).toEqual([1, 1]);
    // The WAL's content was folded in, not discarded.
    expect(countRows(dbPath)).toBe(250);
  });

  test("recovers the live incident shape: rollback-mode header with the WHOLE database in the sidecar", () => {
    // Observed on the live home: state.db 4 KB with header bytes 1/1 next to
    // a 1.1 MB state.db-wal — the header flip to WAL itself was still
    // un-checkpointed. SQLite opens the WAL for any non-empty db with a
    // sidecar regardless of header, so conversion must recover every row.
    const dbPath = buildUncheckpointedWalDb(dir, "state.db", 100);
    const patched = readFileSync(dbPath);
    patched[18] = 1;
    patched[19] = 1;
    writeFileSync(dbPath, patched);
    expect(headerVersions(dbPath)).toEqual([1, 1]);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const sweep = convertWalDbsToDeleteJournal(dir);

    expect(sweep.entries.map((e) => e.action)).toEqual(["converted"]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(headerVersions(dbPath)).toEqual([1, 1]);
    expect(countRows(dbPath)).toBe(100);
  });

  test("converts a checkpointed WAL database (WAL header, no sidecar left)", () => {
    // A fully-checkpointed WAL db with its sidecars gone still carries the
    // WAL header — the next open (in-container) would recreate the WAL
    // machinery over virtiofs and fail, so this shape needs converting too.
    const dbPath = join(dir, "workflow.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("INSERT INTO t (v) VALUES ('x');");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();
    // The checkpoint emptied the WAL, so removing the sidecars here loses
    // nothing — this is fixture setup, not the module's own behavior.
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    expect(headerVersions(dbPath)).toEqual([2, 2]);

    const sweep = convertWalDbsToDeleteJournal(dir);

    expect(sweep.entries.map((e) => e.action)).toEqual(["converted"]);
    expect(sweep.entries[0]?.walBytes).toBe(0);
    expect(headerVersions(dbPath)).toEqual([1, 1]);
    expect(countRows(dbPath)).toBe(1);
  });

  test("leaves a healthy rollback-mode database untouched, byte for byte", () => {
    const dbPath = join(dir, "index.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
    db.close();
    const before = readFileSync(dbPath);

    const sweep = convertWalDbsToDeleteJournal(dir);

    expect(sweep.scanned).toBe(1);
    expect(sweep.entries).toEqual([]);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  test("detects SQLite files by magic, not filename, and skips non-SQLite files", () => {
    // akm keeps SQLite stores under non-.db names too (e.g. the maintenance
    // barrier lock file), so detection is by header magic.
    const lockDb = buildUncheckpointedWalDb(dir, ".maintenance.barrier.lock", 5);
    writeFileSync(join(dir, "junk.db"), "X".repeat(64)); // .db name, not SQLite
    writeFileSync(join(dir, "tiny.db"), "short"); // under 20 bytes
    writeFileSync(join(dir, "empty.db"), ""); // zero bytes

    const sweep = convertWalDbsToDeleteJournal(dir);

    expect(sweep.scanned).toBe(4);
    expect(sweep.entries).toEqual([
      { dbPath: lockDb, action: "converted", walBytes: expect.any(Number) },
    ]);
    expect(readFileSync(join(dir, "junk.db"), "utf-8")).toBe("X".repeat(64));
  });

  test("never touches .bak backup snapshots, even ones carrying WAL residue", () => {
    // The runbook's manual heal leaves state.db.manual-backup-<ts>.bak files;
    // nothing ever opens a backup, and converting one would mutate it.
    const bakPath = buildUncheckpointedWalDb(dir, "state.db.manual-backup-20260831T151303.bak", 5);
    const before = readFileSync(bakPath);

    const sweep = convertWalDbsToDeleteJournal(dir);

    expect(sweep.scanned).toBe(0);
    expect(sweep.entries).toEqual([]);
    expect(readFileSync(bakPath).equals(before)).toBe(true);
    expect(existsSync(`${bakPath}-wal`)).toBe(true);
  });

  test("reports an orphaned -wal sidecar and never deletes it", () => {
    const walPath = join(dir, "ghost.db-wal");
    writeFileSync(walPath, Buffer.alloc(4096, 7));

    const sweep = convertWalDbsToDeleteJournal(dir);

    expect(sweep.entries).toEqual([
      {
        dbPath: join(dir, "ghost.db"),
        action: "orphaned-wal",
        walBytes: 4096,
        detail: "-wal sidecar has no companion database file; left in place",
      },
    ]);
    expect(existsSync(walPath)).toBe(true);
  });

  test("recurses into subdirectories", () => {
    const nestedDir = join(dir, "maintenance-activities", "act-1");
    mkdirSync(nestedDir, { recursive: true });
    const nested = buildUncheckpointedWalDb(nestedDir, "activity.db", 3);

    const sweep = convertWalDbsToDeleteJournal(dir);

    expect(sweep.entries.map((e) => e.dbPath)).toEqual([nested]);
    expect(countRows(nested)).toBe(3);
  });

  test("is idempotent: a second sweep finds nothing to do", () => {
    buildUncheckpointedWalDb(dir, "state.db", 20);
    expect(convertWalDbsToDeleteJournal(dir).entries.map((e) => e.action)).toEqual(["converted"]);

    const second = convertWalDbsToDeleteJournal(dir);
    expect(second.entries).toEqual([]);
    expect(second.scanned).toBe(1);
  });

  test("returns an empty result for a missing root", () => {
    const sweep = convertWalDbsToDeleteJournal(join(dir, "does-not-exist"));
    expect(sweep).toEqual({ root: join(dir, "does-not-exist"), scanned: 0, entries: [] });
  });
});

describe("reconcileAkmDbJournalMode", () => {
  test("sweeps both akm data roots on a VM-mediated runtime", () => {
    const assistantRoot = join(dir, "data", "akm", "data");
    mkdirSync(assistantRoot, { recursive: true });
    const dbPath = buildUncheckpointedWalDb(assistantRoot, "state.db", 40);

    const results = reconcileAkmDbJournalMode({ homeDir: dir }, VM_RUNTIME);

    expect(results.map((r) => r.root)).toEqual([
      join(dir, "data", "akm", "data"),
      join(dir, "data", "paperclip-akm", "data"),
    ]);
    expect(results[0]?.entries).toEqual([
      { dbPath, action: "converted", walBytes: expect.any(Number) },
    ]);
    // The paperclip root does not exist on this home — still reported, empty.
    expect(results[1]?.scanned).toBe(0);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(countRows(dbPath)).toBe(40);
  });

  test("is a no-op on native Linux, where in-container WAL is legitimate and possibly live", () => {
    const assistantRoot = join(dir, "data", "akm", "data");
    mkdirSync(assistantRoot, { recursive: true });
    const dbPath = buildUncheckpointedWalDb(assistantRoot, "state.db", 4);

    const results = reconcileAkmDbJournalMode({ homeDir: dir }, LINUX_RUNTIME);

    expect(results).toEqual([]);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
  });

  test("sweeps exactly the roots ensureHomeDirs creates for akm data", () => {
    // Literal strings on purpose: these must track the container mounts in
    // core.compose.yml / services.compose.yml (/opt/akm/data bind sources).
    expect(akmDataRoots("/home/op")).toEqual([
      "/home/op/data/akm/data",
      "/home/op/data/paperclip-akm/data",
    ]);
  });
});
