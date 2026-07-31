/**
 * `fetchAccessStatusActual` / `resolveContainerActualStatus` — the "actual"
 * half of the Phase 2 access-status endpoint (see the module doc comment for
 * why this stops at container state/health rather than a literal Docker
 * port-publish query).
 *
 * `composePs` is injected (the `access-apply.test.ts` pattern) rather than
 * module-mocked: a whole-module mock is process-global in Bun and leaks into
 * unrelated files at the aggregate `bun run test` scale.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchAccessStatusActual, resolveContainerActualStatus } from "./access-status.ts";
import { stackEnvFile } from "./home.ts";
import type { composePs, ComposePsRow } from "./docker.ts";
import type { ControlPlaneState } from "./types.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeHome(): ControlPlaneState {
  const home = mkdtempSync(join(tmpdir(), "op-access-status-"));
  tmpDirs.push(home);
  const envPath = stackEnvFile(home);
  mkdirSync(join(envPath, ".."), { recursive: true });
  writeFileSync(envPath, "");
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

function stubComposePs(stdout: string): typeof composePs {
  return (async () => ({ ok: true, stdout, stderr: "", code: 0 })) as typeof composePs;
}

function failingComposePs(): typeof composePs {
  return (async () => ({ ok: false, stdout: "", stderr: "daemon unreachable", code: 1 })) as typeof composePs;
}

function rowLine(service: string, state: string, health = ""): string {
  return JSON.stringify({ Service: service, State: state, Health: health });
}

describe("resolveContainerActualStatus", () => {
  const rows: ComposePsRow[] = [
    { service: "assistant", state: "running", health: "healthy", id: "assistant-id" },
    { service: "guardian", state: "exited", health: "", id: "guardian-id" },
  ];

  test("a running, healthy row reports deployed+running+healthy", () => {
    expect(resolveContainerActualStatus(rows, "assistant")).toEqual({
      deployed: true,
      running: true,
      healthy: true,
    });
  });

  test("an exited row reports deployed but not running/healthy", () => {
    expect(resolveContainerActualStatus(rows, "guardian")).toEqual({
      deployed: true,
      running: false,
      healthy: false,
    });
  });

  test("no row at all (never deployed) reports every flag false", () => {
    expect(resolveContainerActualStatus([], "assistant")).toEqual({
      deployed: false,
      running: false,
      healthy: false,
    });
  });

  test("running with no health field at all still counts as healthy (no healthcheck configured)", () => {
    const noHealthcheck: ComposePsRow[] = [{ service: "assistant", state: "running", health: "", id: "assistant-id" }];
    expect(resolveContainerActualStatus(noHealthcheck, "assistant").healthy).toBe(true);
  });

  test("running but explicitly unhealthy is not healthy", () => {
    const unhealthy: ComposePsRow[] = [{ service: "assistant", state: "running", health: "unhealthy", id: "assistant-id" }];
    expect(resolveContainerActualStatus(unhealthy, "assistant").healthy).toBe(false);
  });
});

describe("fetchAccessStatusActual", () => {
  test("both containers running+healthy", async () => {
    const state = makeHome();
    const stdout = [rowLine("assistant", "running", "healthy"), rowLine("guardian", "running", "healthy")].join(
      "\n",
    );
    const result = await fetchAccessStatusActual(state, { composePs: stubComposePs(stdout) });
    expect(result.assistant).toEqual({ deployed: true, running: true, healthy: true });
    expect(result.guardian).toEqual({ deployed: true, running: true, healthy: true });
  });

  test("guardian never deployed (no guardian-ingress addon enabled)", async () => {
    const state = makeHome();
    const stdout = rowLine("assistant", "running", "healthy");
    const result = await fetchAccessStatusActual(state, { composePs: stubComposePs(stdout) });
    expect(result.assistant?.deployed).toBe(true);
    expect(result.guardian).toEqual({ deployed: false, running: false, healthy: false });
  });

  test("an unreachable daemon degrades BOTH entries to null, never throws", async () => {
    const state = makeHome();
    const result = await fetchAccessStatusActual(state, { composePs: failingComposePs() });
    expect(result).toEqual({ assistant: null, guardian: null });
  });

  test("a composePs that throws also degrades to null instead of propagating", async () => {
    const state = makeHome();
    const throwing = (async () => {
      throw new Error("boom");
    }) as typeof composePs;
    const result = await fetchAccessStatusActual(state, { composePs: throwing });
    expect(result).toEqual({ assistant: null, guardian: null });
  });
});
