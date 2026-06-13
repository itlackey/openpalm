/**
 * AC tests for the deploy journal (WS-A A3).
 *
 * Covers:
 *   1. Round-trip: writeJournal → readDeployJournal returns identical state.
 *   2. Dead-PID + deploying:true hydrates to interrupted (deploying→false,
 *      interrupted→true, deployError populated).
 *   3. Journal file is written with mode 0600.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJournal, readDeployJournal, type DeployProgress } from "./deploy.js";

// ── Fixture ────────────────────────────────────────────────────────────────

function makeProgress(overrides: Partial<DeployProgress> = {}): DeployProgress {
  return {
    deploying: false,
    interrupted: false,
    setupComplete: false,
    deployStatus: [],
    deployError: null,
    imageWarning: null,
    phase: 'writing-config',
    startedAt: null,
    pid: null,
    ...overrides,
  };
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe("deploy journal", () => {
  let tempDir: string;

  function setup(): string {
    tempDir = mkdtempSync(join(tmpdir(), "op-deploy-journal-"));
    return join(tempDir, "setup", "deploy-journal.json");
  }

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trip: writeJournal then readDeployJournal returns equivalent state", () => {
    const path = setup();
    const progress = makeProgress({
      deploying: true,
      setupComplete: false,
      deployStatus: [{ service: "guardian", status: "running", label: "Running" }],
      deployError: null,
      imageWarning: null,
      phase: "starting",
      startedAt: "2026-06-13T00:00:00.000Z",
      pid: process.pid,
    });

    writeJournal(path, progress);
    const read = readDeployJournal(path);

    // The process is still alive so deploying stays true, not interrupted.
    expect(read.deploying).toBe(true);
    expect(read.interrupted).toBe(false);
    expect(read.setupComplete).toBe(false);
    expect(read.phase).toBe("starting");
    expect(read.startedAt).toBe("2026-06-13T00:00:00.000Z");
    expect(read.pid).toBe(process.pid);
    expect(read.deployStatus).toHaveLength(1);
    expect(read.deployStatus[0]).toEqual({ service: "guardian", status: "running", label: "Running" });
    expect(read.deployError).toBeNull();
    expect(read.imageWarning).toBeNull();
  });

  it("round-trip: completed journal (deploying:false, setupComplete:true) preserved", () => {
    const path = setup();
    const progress = makeProgress({
      deploying: false,
      setupComplete: true,
      phase: "ready",
      startedAt: "2026-06-13T01:00:00.000Z",
    });

    writeJournal(path, progress);
    const read = readDeployJournal(path);

    expect(read.deploying).toBe(false);
    expect(read.setupComplete).toBe(true);
    expect(read.phase).toBe("ready");
  });

  it("dead-PID + deploying:true hydrates to interrupted", () => {
    const path = setup();

    // Use a PID that cannot be alive: PID 0 is the kernel; kill(0, 0) in Node
    // sends to the entire process group and never throws "ESRCH", but we need
    // a dead PID. Use a very large PID that is astronomically unlikely to exist,
    // combined with writing the journal manually so we bypass the in-process PID
    // validity check in writeJournal.
    const deadPid = 2_000_000; // Linux max PID is 4_194_304; this is never a real PID in test.
    mkdirSync(join(tempDir, "setup"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        deploying: true,
        interrupted: false,
        setupComplete: false,
        deployStatus: [],
        deployError: null,
        imageWarning: null,
        phase: "pulling-images",
        startedAt: "2026-06-13T00:00:00.000Z",
        pid: deadPid,
      }),
      { mode: 0o600 },
    );

    const read = readDeployJournal(path);

    expect(read.deploying).toBe(false);
    expect(read.interrupted).toBe(true);
    expect(read.deployError).not.toBeNull();
    expect(read.deployError).toMatch(/interrupted/i);
  });

  it("journal file is written with mode 0600", () => {
    const path = setup();
    writeJournal(path, makeProgress());

    const st = statSync(path);
    // Extract permission bits (lowest 12 bits of mode).
    const perms = st.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it("readDeployJournal returns default state when file does not exist", () => {
    const path = join(mkdtempSync(join(tmpdir(), "op-deploy-missing-")), "missing.json");
    const read = readDeployJournal(path);
    expect(read.deploying).toBe(false);
    expect(read.setupComplete).toBe(false);
    expect(read.deployStatus).toHaveLength(0);
    expect(read.phase).toBe("writing-config");
  });
});
