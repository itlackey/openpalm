/**
 * Reviewer blocker (B1-volumes round 1): the #585 retired-volume reaper
 * (decision 585-B) was wired ONLY into `performUpgrade` — but `openpalm
 * install` on an existing OP_HOME (the documented repair/re-run path) drives
 * the SAME compose transition through `runDeploy` (deploy.ts): `applyInstall`
 * overwrites the managed system/stack compose files wholesale, then
 * `applyStack` brings the new stack up. Without a reap wired into THAT path
 * too, a user who runs `openpalm install` instead of `openpalm update`
 * strands the retired volumes (assistant-artifacts, guardian-cache,
 * portal-cache) permanently — `uninstall --volumes` can't see them (their
 * compose declarations are gone) and `doctor --clean-docker` can't either
 * (`findOrphanVolumes` only flags a DIFFERENT project's volumes).
 *
 * Mirrors lifecycle-volume-reap.test.ts: `runDeploy` must reap exactly once,
 * strictly AFTER `applyStack` succeeds, with the resolved project name, and
 * a reclaim failure must never throw / block setup completion. A third test
 * pins the negative: no reap call at all on the `applyStack` failure branch.
 *
 * `applyStack`/`composePs`/`detectExistingProject` and `reapRetiredVolumes`
 * are all statically imported (by docker.js / deploy.ts / image-volume-retention.js
 * respectively), so this test mocks them via `mock.module` and re-imports
 * deploy.js with a cache-busting query — the same pattern used by
 * lifecycle-volume-reap.test.ts / lifecycle-install-ownership.test.ts.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realDocker from "./docker.js";
import * as realImageVolumeRetention from "./image-volume-retention.js";
import { readStackEnv } from "./secrets.js";

const realApplyStack = realDocker.applyStack;
const realComposePs = realDocker.composePs;
const realDetectExistingProject = realDocker.detectExistingProject;
const realReapRetiredVolumes = realImageVolumeRetention.reapRetiredVolumes;

// mock.module() is NOT undone by mock.restore() and leaks across test files
// sharing this bun test process — always re-point back to the real
// implementation afterward (mirrors lifecycle-volume-reap.test.ts's comment).
afterEach(() => {
  mock.restore();
  mock.module("./docker.js", () => ({
    ...realDocker,
    applyStack: realApplyStack,
    composePs: realComposePs,
    detectExistingProject: realDetectExistingProject,
  }));
  mock.module("./image-volume-retention.js", () => ({
    ...realImageVolumeRetention,
    reapRetiredVolumes: realReapRetiredVolumes,
  }));
});

function withDeployEnv(homeDir: string, run: () => Promise<void>): Promise<void> {
  const saved = {
    OP_HOME: process.env.OP_HOME,
    OP_SKIP_COMPOSE_PREFLIGHT: process.env.OP_SKIP_COMPOSE_PREFLIGHT,
    OP_SKIP_OWNERSHIP_RECONCILE: process.env.OP_SKIP_OWNERSHIP_RECONCILE,
    OP_UI_LOGIN_PASSWORD: process.env.OP_UI_LOGIN_PASSWORD,
  };
  process.env.OP_HOME = homeDir;
  process.env.OP_SKIP_COMPOSE_PREFLIGHT = "1";
  process.env.OP_SKIP_OWNERSHIP_RECONCILE = "1";
  process.env.OP_UI_LOGIN_PASSWORD = "test-password-for-deploy-reap-test";
  return run().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
      else process.env[key as keyof NodeJS.ProcessEnv] = value;
    }
  });
}

describe("runDeploy reclaims retired volumes after the new stack is up (#585 decision 585-B, install path)", () => {
  test("calls reapRetiredVolumes exactly once, with the resolved project name, AFTER applyStack succeeds", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openpalm-deploy-reap-"));
    try {
      await withDeployEnv(homeDir, async () => {
        let applyStackCalled = false;
        let reapCalledAfterApplyStack = false;
        let reapCalledWithProject: string | undefined;

        const applyStackMock = mock(async () => {
          applyStackCalled = true;
          return { ok: true };
        });
        const composePsMock = mock(async () => ({ ok: true, stdout: "" }));
        const detectExistingProjectMock = mock(async () => ({ exists: false }));
        const reapMock = mock(async (projectName: string) => {
          reapCalledAfterApplyStack = applyStackCalled;
          reapCalledWithProject = projectName;
          return { reclaimed: [], errors: [] };
        });

        mock.module("./docker.js", () => ({
          ...realDocker,
          applyStack: applyStackMock,
          composePs: composePsMock,
          detectExistingProject: detectExistingProjectMock,
        }));
        mock.module("./image-volume-retention.js", () => ({
          ...realImageVolumeRetention,
          reapRetiredVolumes: reapMock,
        }));

        const { runDeploy } = await import(`./deploy.js?deploy-reap-test=${Math.random()}`);
        const { createState } = await import(`./lifecycle.js?deploy-reap-test-state=${Math.random()}`);
        const state = createState();

        const result = await runDeploy(state);

        expect(result.deployError).toBeNull();
        expect(result.setupComplete).toBe(true);
        expect(applyStackMock).toHaveBeenCalledTimes(1);
        expect(reapMock).toHaveBeenCalledTimes(1);
        expect(reapCalledAfterApplyStack).toBe(true);
        expect(reapCalledWithProject).toBe(realDocker.resolveComposeProjectName(readStackEnv(homeDir)));
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("a reclaim failure is collected, never thrown — setup still completes", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openpalm-deploy-reap-fail-"));
    try {
      await withDeployEnv(homeDir, async () => {
        const applyStackMock = mock(async () => ({ ok: true }));
        const composePsMock = mock(async () => ({ ok: true, stdout: "" }));
        const detectExistingProjectMock = mock(async () => ({ exists: false }));
        const reapMock = mock(async () => ({
          reclaimed: [],
          errors: ["volume openpalm_guardian-cache: volume is in use"],
        }));

        mock.module("./docker.js", () => ({
          ...realDocker,
          applyStack: applyStackMock,
          composePs: composePsMock,
          detectExistingProject: detectExistingProjectMock,
        }));
        mock.module("./image-volume-retention.js", () => ({
          ...realImageVolumeRetention,
          reapRetiredVolumes: reapMock,
        }));

        const { runDeploy } = await import(`./deploy.js?deploy-reap-fail-test=${Math.random()}`);
        const { createState } = await import(`./lifecycle.js?deploy-reap-fail-test-state=${Math.random()}`);
        const state = createState();

        const result = await runDeploy(state);

        // A reclaim failure must never strand setup — deployError stays null.
        expect(result.deployError).toBeNull();
        expect(result.setupComplete).toBe(true);
        expect(reapMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("never reaps when applyStack fails (no false 'volumes reclaimed' on a broken deploy)", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openpalm-deploy-reap-noop-"));
    try {
      await withDeployEnv(homeDir, async () => {
        const applyStackMock = mock(async () => ({ ok: false, upFailed: true, error: "boom" }));
        const composePsMock = mock(async () => ({ ok: true, stdout: "" }));
        const detectExistingProjectMock = mock(async () => ({ exists: false }));
        const reapMock = mock(async () => ({ reclaimed: [], errors: [] }));

        mock.module("./docker.js", () => ({
          ...realDocker,
          applyStack: applyStackMock,
          composePs: composePsMock,
          detectExistingProject: detectExistingProjectMock,
        }));
        mock.module("./image-volume-retention.js", () => ({
          ...realImageVolumeRetention,
          reapRetiredVolumes: reapMock,
        }));

        const { runDeploy } = await import(`./deploy.js?deploy-reap-noop-test=${Math.random()}`);
        const { createState } = await import(`./lifecycle.js?deploy-reap-noop-test-state=${Math.random()}`);
        const state = createState();

        const result = await runDeploy(state);

        expect(result.deployError).not.toBeNull();
        expect(reapMock).toHaveBeenCalledTimes(0);
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
