import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlaneState } from "./types.js";
import {
  clearArmedSnapshot,
  hasArmedSnapshot,
  hasSnapshot,
  restoreSnapshot,
  snapshotCurrentState,
} from "./rollback.js";

function makeState(home: string): ControlPlaneState {
  return {
    homeDir: home,
    configDir: join(home, "config"),
    stashDir: join(home, "knowledge"),
    workspaceDir: join(home, "workspace"),
    dataDir: join(home, "data"),
    stackDir: join(home, "config", "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
  };
}

describe("rollback snapshot/restore (0.3 — state env + non-destructive restore)", () => {
  let home: string;
  let state: ControlPlaneState;
  let previousOpHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "openpalm-rollback-test-"));
    previousOpHome = process.env.OP_HOME;
    process.env.OP_HOME = home;

    mkdirSync(join(home, "knowledge", "env"), { recursive: true });
    mkdirSync(join(home, "knowledge", "secrets"), { recursive: true });
    mkdirSync(join(home, "state"), { recursive: true });
    mkdirSync(join(home, "config", "stack"), { recursive: true });
    mkdirSync(join(home, "system", "stack"), { recursive: true });

    writeFileSync(join(home, "knowledge", "env", "stack.env"), "OP_IMAGE_NAMESPACE=openpalm\n");
    writeFileSync(join(home, "state", "stack.state.env"), "OP_ENABLED_ADDONS=discord\n");
    writeFileSync(join(home, "config", "stack", "custom.compose.yml"), "services: {}\n");
    writeFileSync(join(home, "system", "stack", "services.compose.yml"), "services: {core: {}}\n");
    writeFileSync(join(home, "system", "stack", "portals.compose.yml"), "services: {}\n");
    writeFileSync(join(home, "system", "stack", "core.compose.yml"), "services: {}\n");
    writeFileSync(join(home, "knowledge", "secrets", "auth.json"), '{"v":1}\n');

    state = makeState(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousOpHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = previousOpHome;
  });

  test("snapshotCurrentState captures state/stack.state.env (the file that wins the compose merge)", () => {
    snapshotCurrentState(state);
    const rollbackDir = join(home, "data", "rollback");
    const snapshotted = join(rollbackDir, "state", "stack.state.env");
    expect(existsSync(snapshotted)).toBe(true);
    expect(readFileSync(snapshotted, "utf-8")).toContain("discord");
  });

  test("restoreSnapshot restores state/stack.state.env", () => {
    snapshotCurrentState(state);
    writeFileSync(join(home, "state", "stack.state.env"), "OP_ENABLED_ADDONS=slack\n");

    restoreSnapshot(state);

    expect(readFileSync(join(home, "state", "stack.state.env"), "utf-8")).toContain("discord");
  });

  test("restoreSnapshot does NOT restore auth.json (drop it from restore; keep the live copy)", () => {
    snapshotCurrentState(state); // captures auth.json v1
    writeFileSync(join(home, "knowledge", "secrets", "auth.json"), '{"v":2}\n');

    restoreSnapshot(state);

    expect(readFileSync(join(home, "knowledge", "secrets", "auth.json"), "utf-8")).toContain('"v":2');
  });

  test("restoreSnapshot backs up the live files it is about to overwrite before touching them", () => {
    snapshotCurrentState(state);
    writeFileSync(join(home, "state", "stack.state.env"), "OP_ENABLED_ADDONS=slack\n");
    writeFileSync(join(home, "knowledge", "env", "stack.env"), "OP_IMAGE_NAMESPACE=custom\n");

    restoreSnapshot(state);

    const backupsDir = join(home, "data", "backups");
    const preRollbackDirs = existsSync(backupsDir)
      ? readdirSync(backupsDir).filter((name) => name.endsWith("-pre-rollback"))
      : [];
    expect(preRollbackDirs.length).toBe(1);

    const backupDir = join(backupsDir, preRollbackDirs.at(0) ?? "");
    expect(readFileSync(join(backupDir, "state", "stack.state.env"), "utf-8")).toContain("slack");
    expect(readFileSync(join(backupDir, "knowledge", "env", "stack.env"), "utf-8")).toContain("custom");
  });

  test("a torn (interrupted) snapshot reads as absent rather than a stale, inconsistent snapshot", () => {
    snapshotCurrentState(state);
    expect(hasSnapshot()).toBe(true);

    // Simulate a crash partway through the NEXT snapshot: one destination file
    // cannot be overwritten, so the copy loop throws before the new ts marker
    // is written.
    const rollbackDir = join(home, "data", "rollback");
    const target = join(rollbackDir, "config", "stack", "custom.compose.yml");
    chmodSync(target, 0o400);
    try {
      writeFileSync(join(home, "config", "stack", "custom.compose.yml"), "services: {changed: true}\n");
      expect(() => snapshotCurrentState(state)).toThrow();
    } finally {
      chmodSync(target, 0o600);
    }

    // The old ts marker must have been cleared at the top of snapshotCurrentState,
    // so the torn (half-written) snapshot correctly reads as absent instead of
    // looking like a complete, trustworthy snapshot at the old timestamp.
    expect(hasSnapshot()).toBe(false);
  });
});

describe("armed-snapshot lifecycle helpers (0.2)", () => {
  let home: string;
  let state: ControlPlaneState;
  let previousOpHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "openpalm-armed-test-"));
    previousOpHome = process.env.OP_HOME;
    process.env.OP_HOME = home;
    mkdirSync(join(home, "knowledge", "env"), { recursive: true });
    writeFileSync(join(home, "knowledge", "env", "stack.env"), "OP_IMAGE_NAMESPACE=openpalm\n");
    state = makeState(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousOpHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = previousOpHome;
  });

  test("clearArmedSnapshot clears the armed marker written by an armed snapshot", () => {
    snapshotCurrentState(state, { arm: true });
    expect(hasArmedSnapshot()).toBe(true);

    clearArmedSnapshot();

    expect(hasArmedSnapshot()).toBe(false);
  });
});
