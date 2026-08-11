/**
 * reconcileGuardianDeployment makes the guardian's RUNNING state match
 * guardianRequired after a mutation that may have changed the answer as a
 * side effect — the transitions per-addon service lists cannot express.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reconcileGuardianDeployment,
  type GuardianReconcileDeps,
} from "./guardian-reconcile.ts";
import { stackEnvFile } from "./home.ts";
import type { ControlPlaneState } from "./types.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeState(stackEnv: string): ControlPlaneState {
  const home = mkdtempSync(join(tmpdir(), "op-guardian-reconcile-"));
  tmpDirs.push(home);
  const envPath = stackEnvFile(home);
  mkdirSync(join(envPath, ".."), { recursive: true });
  writeFileSync(envPath, stackEnv);
  return {
    homeDir: home,
    configDir: join(home, "config"),
    stashDir: join(home, "knowledge"),
    workspaceDir: join(home, "workspace"),
    dataDir: join(home, "data"),
    stackDir: join(home, "system", "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
  } as ControlPlaneState;
}

function makeDeps(running: string[]) {
  const calls = { started: 0, stopped: 0, stopProfiles: [] as string[][] };
  const deps: GuardianReconcileDeps = {
    listRunningServices: async () => running,
    startGuardian: async () => {
      calls.started += 1;
    },
    stopGuardian: async (_state, options) => {
      calls.stopped += 1;
      calls.stopProfiles.push(options.profiles);
    },
  };
  return { deps, calls };
}

describe("reconcileGuardianDeployment", () => {
  test("stops a running guardian nothing requires anymore", async () => {
    const state = makeState("OP_ENABLED_ADDONS=\n");
    const { deps, calls } = makeDeps(["assistant", "guardian"]);

    const result = await reconcileGuardianDeployment(state, { deps });

    expect(result).toEqual({ action: "stopped", ok: true });
    expect(calls.stopped).toBe(1);
    expect(calls.started).toBe(0);
  });

  test("starts a required guardian that is not running — e.g. a sibling portal's disable stopped the shared service", async () => {
    const state = makeState("OP_ENABLED_ADDONS=slack\n");
    const { deps, calls } = makeDeps(["assistant"]);

    const result = await reconcileGuardianDeployment(state, { deps });

    expect(result).toEqual({ action: "started", ok: true });
    expect(calls.started).toBe(1);
    expect(calls.stopped).toBe(0);
  });

  test("starts the guardian for a remote tunnel targeting it — the UI enable path's gap", async () => {
    const state = makeState("OP_ENABLED_ADDONS=remote\nOP_REMOTE_TARGET=guardian\n");
    const { deps, calls } = makeDeps(["assistant", "tunnel"]);

    const result = await reconcileGuardianDeployment(state, { deps });

    expect(result).toEqual({ action: "started", ok: true });
    expect(calls.started).toBe(1);
  });

  test("no-ops when the state already matches, in both directions", async () => {
    const requiredAndRunning = makeState("OP_ENABLED_ADDONS=gateway\n");
    const a = makeDeps(["assistant", "guardian"]);
    expect(await reconcileGuardianDeployment(requiredAndRunning, { deps: a.deps })).toEqual({
      action: "none",
      ok: true,
    });
    expect(a.calls.started + a.calls.stopped).toBe(0);

    const neitherRequiredNorRunning = makeState("OP_ENABLED_ADDONS=voice\n");
    const b = makeDeps(["assistant", "voice"]);
    expect(await reconcileGuardianDeployment(neitherRequiredNorRunning, { deps: b.deps })).toEqual({
      action: "none",
      ok: true,
    });
    expect(b.calls.started + b.calls.stopped).toBe(0);
  });

  test("a failed probe is reported, never acted on", async () => {
    const state = makeState("OP_ENABLED_ADDONS=\n");
    const { calls, deps } = makeDeps([]);
    deps.listRunningServices = async () => {
      throw new Error("docker compose ps failed");
    };

    const result = await reconcileGuardianDeployment(state, { deps });

    expect(result.ok).toBe(false);
    expect(result.action).toBe("none");
    expect(result.error).toContain("ps failed");
    expect(calls.started + calls.stopped).toBe(0);
  });
});
