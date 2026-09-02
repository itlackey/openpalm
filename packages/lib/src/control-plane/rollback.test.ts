import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteServeConfigDir } from "./home.js";
import { resolveServeConfig } from "./remote-access.js";
import { writeServeConfig } from "./remote-apply.js";
import {
  currentSnapshotGeneration,
  hasSnapshot,
  restoreSnapshot,
  snapshotCurrentState,
} from "./rollback.js";
import { DELEGATED_SECRET_NAMES } from "./secrets-migration.js";
import type { ControlPlaneState } from "./types.js";

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

function readServeDoc(home: string): unknown {
  return JSON.parse(readFileSync(join(remoteServeConfigDir(home), "serve.json"), "utf-8"));
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

    mkdirSync(join(home, "state"), { recursive: true });
    mkdirSync(join(home, "knowledge", "secrets"), { recursive: true });
    mkdirSync(join(home, "state"), { recursive: true });
    mkdirSync(join(home, "config", "stack"), { recursive: true });
    mkdirSync(join(home, "system", "stack"), { recursive: true });

    writeFileSync(join(home, "state", "stack.env"), "OP_IMAGE_NAMESPACE=openpalm\n");
    writeFileSync(join(home, "state", "stack.env"), "OP_ENABLED_ADDONS=discord\n");
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

  test("snapshotCurrentState captures state/stack.env (the file that wins the compose merge)", () => {
    snapshotCurrentState(state);
    const rollbackDir = join(home, "data", "rollback");
    const snapshotted = join(rollbackDir, "state", "stack.env");
    expect(existsSync(snapshotted)).toBe(true);
    expect(readFileSync(snapshotted, "utf-8")).toContain("discord");
  });

  test("restoreSnapshot restores state/stack.env", () => {
    snapshotCurrentState(state);
    writeFileSync(join(home, "state", "stack.env"), "OP_ENABLED_ADDONS=slack\n");

    restoreSnapshot(state);

    expect(readFileSync(join(home, "state", "stack.env"), "utf-8")).toContain("discord");
  });

  test("restoreSnapshot regenerates an empty serve policy when rollback disables remote", () => {
    writeFileSync(
      join(home, "state", "stack.env"),
      "OP_ENABLED_ADDONS=\nOP_REMOTE_PUBLIC=true\nOP_REMOTE_TARGET=assistant\n",
    );
    snapshotCurrentState(state);
    expect(existsSync(join(home, "data", "rollback", "state", "remote", "serve.json"))).toBe(false);

    // Simulate a failed apply that left the live generated policy public.
    writeFileSync(
      join(home, "state", "stack.env"),
      "OP_ENABLED_ADDONS=remote\nOP_REMOTE_PUBLIC=true\nOP_REMOTE_TARGET=assistant\n",
    );
    writeServeConfig(home, { hostname: "openpalm", public: true, target: "assistant" });
    expect((readServeDoc(home) as { AllowFunnel: Record<string, boolean> }).AllowFunnel)
      .toEqual({ "${TS_CERT_DOMAIN}:443": true, "${TS_CERT_DOMAIN}:3820": false });

    restoreSnapshot(state);

    expect(readFileSync(join(home, "state", "stack.env"), "utf-8")).toContain("OP_ENABLED_ADDONS=\n");
    expect(readServeDoc(home)).toEqual({ TCP: {}, Web: {}, AllowFunnel: {} });
  });

  test("restoreSnapshot regenerates explicit false Funnel policy when rollback is private", () => {
    writeFileSync(
      join(home, "state", "stack.env"),
      "OP_ENABLED_ADDONS=remote\nOP_REMOTE_PUBLIC=false\nOP_REMOTE_TARGET=assistant\nOP_REMOTE_HOSTNAME=openpalm\n",
    );
    snapshotCurrentState(state);

    // Simulate a failed apply that left the live generated policy public.
    writeFileSync(
      join(home, "state", "stack.env"),
      "OP_ENABLED_ADDONS=remote\nOP_REMOTE_PUBLIC=true\nOP_REMOTE_TARGET=assistant\nOP_REMOTE_HOSTNAME=openpalm\n",
    );
    writeServeConfig(home, { hostname: "openpalm", public: true, target: "assistant" });

    restoreSnapshot(state);

    expect(readFileSync(join(home, "state", "stack.env"), "utf-8")).toContain("OP_REMOTE_PUBLIC=false");
    expect(readServeDoc(home)).toEqual(resolveServeConfig({
      hostname: "openpalm",
      public: false,
      target: "assistant",
    }));
    const allowFunnel = (readServeDoc(home) as { AllowFunnel: Record<string, boolean> }).AllowFunnel;
    expect(Object.values(allowFunnel).every((value) => value === false)).toBe(true);
  });

  test("restoreSnapshot removes a skeleton stamp absent from the snapshot", () => {
    snapshotCurrentState(state);
    writeFileSync(join(home, ".skeleton-version"), "0.13.1\n");

    restoreSnapshot(state);

    expect(existsSync(join(home, ".skeleton-version"))).toBe(false);
    expect(existsSync(join(home, "state", "stack.env"))).toBe(true);
  });

  test("restoreSnapshot does NOT restore auth.json (drop it from restore; keep the live copy)", () => {
    snapshotCurrentState(state); // captures auth.json v1
    writeFileSync(join(home, "knowledge", "secrets", "auth.json"), '{"v":2}\n');

    restoreSnapshot(state);

    expect(readFileSync(join(home, "knowledge", "secrets", "auth.json"), "utf-8")).toContain('"v":2');
  });

  test("restoreSnapshot backs up the live files it is about to overwrite before touching them", () => {
    snapshotCurrentState(state);
    writeFileSync(join(home, "state", "stack.env"), "OP_ENABLED_ADDONS=slack\nOP_IMAGE_NAMESPACE=custom\n");

    restoreSnapshot(state);

    const backupsDir = join(home, "data", "backups");
    const preRollbackDirs = existsSync(backupsDir)
      ? readdirSync(backupsDir).filter((name) => name.endsWith("-pre-rollback"))
      : [];
    expect(preRollbackDirs.length).toBe(1);

    const backupDir = join(backupsDir, preRollbackDirs.at(0) ?? "");
    expect(readFileSync(join(backupDir, "state", "stack.env"), "utf-8")).toContain("slack");
    expect(readFileSync(join(backupDir, "state", "stack.env"), "utf-8")).toContain("custom");
  });

  test("#657 pt.2 — restoreSnapshot caps -pre-rollback snapshots instead of leaving them to accumulate unbounded", () => {
    // backups.ts documented this namespace as "never pruned by anything" —
    // that was the bug, not a guarantee. Seed 4 pre-existing -pre-rollback
    // snapshots (older than the one this restoreSnapshot call is about to
    // create) to prove the cap actually deletes the oldest ones rather than
    // just capping future growth.
    snapshotCurrentState(state);
    const backupsDir = join(home, "data", "backups");
    mkdirSync(backupsDir, { recursive: true });
    const seeded: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const dir = join(backupsDir, `2020-01-0${i + 1}T00-00-00-000Z-pre-rollback`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "marker.txt"), String(i));
      // Oldest (i=0) to newest (i=3) of the 4 seeded snapshots, all older than
      // "now" (what the real restoreSnapshot call below creates).
      const t = new Date(Date.now() - (10_000 - i * 1_000));
      utimesSync(dir, t, t);
      seeded.push(dir);
    }

    restoreSnapshot(state);

    // 4 seeded + 1 just-created = 5 total; the cap of 3 leaves the 3 newest:
    // the just-created one, plus the 2 newest seeded ones.
    const preRollbackDirs = readdirSync(backupsDir).filter((name) => name.endsWith("-pre-rollback"));
    expect(preRollbackDirs).toHaveLength(3);
    expect(existsSync(seeded[0])).toBe(false);
    expect(existsSync(seeded[1])).toBe(false);
    expect(existsSync(seeded[2])).toBe(true);
    expect(existsSync(seeded[3])).toBe(true);
  });

  test("a torn snapshot preserves the previous complete generation", () => {
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

    expect(hasSnapshot()).toBe(true);
    restoreSnapshot(state);
    expect(readFileSync(join(home, "config", "stack", "custom.compose.yml"), "utf8")).toBe("services: {}\n");
  });

  test("each snapshot is an isolated generation and does not retain retired files", () => {
    snapshotCurrentState(state);
    const oldOnly = join(home, "system", "stack", "old.yml");
    writeFileSync(oldOnly, "old\n");
    snapshotCurrentState(state);
    rmSync(oldOnly);
    snapshotCurrentState(state);
    restoreSnapshot(state);
    expect(existsSync(oldOnly)).toBe(false);
  });

  test("restoreSnapshot restores the complete managed system generation", () => {
    const assistantPolicy = join(home, "system", "assistant", "AGENTS.md");
    mkdirSync(join(home, "system", "assistant"), { recursive: true });
    writeFileSync(assistantPolicy, "old policy\n");
    const generation = snapshotCurrentState(state);

    writeFileSync(assistantPolicy, "new policy\n");
    writeFileSync(join(home, "system", "stack", "new.yml"), "new\n");
    rmSync(join(home, "system", "stack", "services.compose.yml"));

    restoreSnapshot(state, generation);

    expect(readFileSync(assistantPolicy, "utf8")).toBe("old policy\n");
    expect(existsSync(join(home, "system", "stack", "new.yml"))).toBe(false);
    expect(existsSync(join(home, "system", "stack", "services.compose.yml"))).toBe(true);
  });

  test("restoreSnapshot leaves a bootstrapped live file when the snapshot predates it", () => {
    rmSync(join(home, "state", "stack.env"));
    snapshotCurrentState(state);
    writeFileSync(join(home, "state", "stack.env"), "OP_SETUP_COMPLETE=false\n");

    restoreSnapshot(state);

    expect(readFileSync(join(home, "state", "stack.env"), "utf8")).toContain("OP_SETUP_COMPLETE=false");
  });

  test("recognizes and restores the shipped flat snapshot layout", () => {
    const rollbackDir = join(home, "data", "rollback");
    mkdirSync(join(rollbackDir, "state"), { recursive: true });
    writeFileSync(join(rollbackDir, ".snapshot-ts"), "2026-01-01T00:00:00.000Z\n");
    writeFileSync(join(rollbackDir, "state", "stack.env"), "OP_ENABLED_ADDONS=api\n");

    expect(hasSnapshot()).toBe(true);
    expect(currentSnapshotGeneration()).toBe('.');
    snapshotCurrentState(state, { activate: false });
    restoreSnapshot(state, '.');
    expect(readFileSync(join(home, "state", "stack.env"), "utf8")).toContain("api");
  });

  test("retains only the three newest rollback generations", () => {
    for (let i = 0; i < 5; i += 1) snapshotCurrentState(state);

    const generations = readdirSync(join(home, "data", "rollback")).filter((name) => name.startsWith("generation-"));
    expect(generations).toHaveLength(3);
  });

  test("pruning never evicts the generation .snapshot-current points at (rollback retries)", () => {
    // The activated snapshot is the restore target for every later rollback.
    const target = snapshotCurrentState(state);
    // Repeated `openpalm rollback` runs each take a pre-rollback snapshot with
    // activate:false, which does NOT move the pointer.
    for (let i = 0; i < 3; i += 1) snapshotCurrentState(state, { activate: false });

    const rollbackDir = join(home, "data", "rollback");
    expect(readFileSync(join(rollbackDir, ".snapshot-current"), "utf8").trim()).toBe(target);
    expect(existsSync(join(rollbackDir, target))).toBe(true);
    // The pointer target survives IN ADDITION to the three newest generations.
    restoreSnapshot(state, target);
  });

  test("#669 restoreSnapshot puts a delegated secret back in knowledge/secrets/ after the migration relocated it mid-update", () => {
    const name = [...DELEGATED_SECRET_NAMES][0] ?? "op_guardian_admin_token";
    const oldPath = join(home, "knowledge", "secrets", name);
    const newPath = join(home, "state", "secrets", name);
    writeFileSync(oldPath, "pre-upgrade-token\n");

    // Snapshot BEFORE the migration runs — the pre-upgrade layout (secret
    // still only in knowledge/secrets/).
    snapshotCurrentState(state);

    // Simulate migrateDelegatedSecretsToStateDir relocating it as part of the
    // SAME (later-failing) update: copy to state/secrets/, remove the
    // knowledge/secrets/ original.
    mkdirSync(join(home, "state", "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(newPath, "pre-upgrade-token\n", { mode: 0o600 });
    rmSync(oldPath);

    restoreSnapshot(state);

    // The reverted (pre-upgrade) compose still expects the secret sourced
    // from knowledge/secrets/ — restoring it there is what makes the rolled
    // back home startable again. The already-migrated copy in state/secrets/
    // is left in place, never deleted.
    expect(readFileSync(oldPath, "utf-8")).toBe("pre-upgrade-token\n");
    expect(readFileSync(newPath, "utf-8")).toBe("pre-upgrade-token\n");
  });

  test("#669 restoreSnapshot does not fabricate a delegated secret that never existed in knowledge/secrets/", () => {
    const name = [...DELEGATED_SECRET_NAMES][0] ?? "op_guardian_admin_token";
    const newPath = join(home, "state", "secrets", name);

    // A home already past the migration when the snapshot is taken — the
    // secret lives only in state/secrets/, nothing in knowledge/secrets/.
    mkdirSync(join(home, "state", "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(newPath, "already-migrated-token\n", { mode: 0o600 });
    snapshotCurrentState(state);

    restoreSnapshot(state);

    expect(existsSync(join(home, "knowledge", "secrets", name))).toBe(false);
    expect(readFileSync(newPath, "utf-8")).toBe("already-migrated-token\n");
  });

  test("restoring a legacy flat snapshot leaves other live system/ subtrees intact", () => {
    // Legacy pre-0.13 flat layout: files directly under data/rollback, no
    // .snapshot-current pointer, and only the stack compose files captured.
    const rollbackDir = join(home, "data", "rollback");
    mkdirSync(join(rollbackDir, "system", "stack"), { recursive: true });
    mkdirSync(join(rollbackDir, "state"), { recursive: true });
    writeFileSync(join(rollbackDir, ".snapshot-ts"), "2026-01-01T00:00:00.000Z\n");
    writeFileSync(join(rollbackDir, "state", "stack.env"), "OP_ENABLED_ADDONS=api\n");
    writeFileSync(join(rollbackDir, "system", "stack", "core.compose.yml"), "services: {snapshotted: true}\n");

    // Live system/ trees the flat snapshot never captured.
    mkdirSync(join(home, "system", "assistant"), { recursive: true });
    writeFileSync(join(home, "system", "assistant", "AGENTS.md"), "live policy\n");
    writeFileSync(join(home, ".skeleton-version"), "0.12.9\n");

    restoreSnapshot(state);

    expect(readFileSync(join(home, "system", "stack", "core.compose.yml"), "utf8")).toBe("services: {snapshotted: true}\n");
    expect(readFileSync(join(home, "state", "stack.env"), "utf8")).toContain("api");
    // Not delete-and-rebuild: subtrees and the version stamp survive.
    expect(readFileSync(join(home, "system", "assistant", "AGENTS.md"), "utf8")).toBe("live policy\n");
    expect(existsSync(join(home, "system", "stack", "services.compose.yml"))).toBe(true);
    expect(existsSync(join(home, ".skeleton-version"))).toBe(true);
  });
});
