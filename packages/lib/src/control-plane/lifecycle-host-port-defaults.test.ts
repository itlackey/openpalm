/**
 * #660: `applyManagedFiles` (lifecycle.ts) must call `ensureHostPortDefaults`
 * on EVERY apply — install and update alike — so a compose-published host
 * port left absent from `state/stack.env` never falls blindly onto compose's
 * own bare default and collides with a sibling instance (the multi-instance
 * smoke's actual failure).
 *
 * `ensureHostPortDefaults` is statically imported by lifecycle.ts, so this
 * mocks it via `mock.module` and re-imports lifecycle.ts with a cache-busting
 * query — the same pattern `lifecycle-install-ownership.test.ts` uses for
 * `reconcileHostOwnership` (see that file's header comment for why: bun's
 * `mock.module()` rewrites a module's live export bindings in place, so the
 * restore must delegate to a function reference captured at file-load time,
 * never to a live read of the mocked namespace).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realConfigPersistence from "./config-persistence.js";

const realEnsureHostPortDefaults = realConfigPersistence.ensureHostPortDefaults;

// mock.module() is NOT undone by mock.restore() and leaks across test files
// sharing this bun test process — always re-point back to the real
// implementation afterward (mirrors lifecycle-install-ownership.test.ts).
afterEach(() => {
  mock.restore();
  mock.module("./config-persistence.js", () => ({
    ...realConfigPersistence,
    ensureHostPortDefaults: realEnsureHostPortDefaults,
  }));
});

describe("applyManagedFiles calls ensureHostPortDefaults on every apply (#660)", () => {
  test("applyInstall calls it once, before applyHome writes the managed system/ tree", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openpalm-install-port-defaults-"));
    const savedHome = process.env.OP_HOME;
    const savedSkip = process.env.OP_SKIP_COMPOSE_PREFLIGHT;
    process.env.OP_HOME = homeDir;
    process.env.OP_SKIP_COMPOSE_PREFLIGHT = "1";

    try {
      let systemTreeExistedAtCallTime: boolean | null = null;
      let capturedHomeDir: string | undefined;
      const ensureHostPortDefaultsMock = mock(async (state: { homeDir: string }) => {
        systemTreeExistedAtCallTime = existsSync(join(homeDir, "system"));
        capturedHomeDir = state.homeDir;
      });

      mock.module("./config-persistence.js", () => ({
        ...realConfigPersistence,
        ensureHostPortDefaults: ensureHostPortDefaultsMock,
      }));

      const { applyInstall, createState } = await import(
        `./lifecycle.js?port-defaults-install-test=${Math.random()}`
      );

      const state = createState();
      await applyInstall(state);

      expect(ensureHostPortDefaultsMock).toHaveBeenCalledTimes(1);
      // Called BEFORE applyHome writes the managed system/ tree.
      expect(systemTreeExistedAtCallTime).toBe(false);
      expect(capturedHomeDir).toBe(homeDir);
      // applyInstall did go on to actually write the managed tree afterward —
      // confirms this isn't passing merely because applyManagedFiles never ran.
      expect(existsSync(join(homeDir, "system"))).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = savedHome;
      if (savedSkip === undefined) delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
      else process.env.OP_SKIP_COMPOSE_PREFLIGHT = savedSkip;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("performUpgrade calls it once", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openpalm-upgrade-port-defaults-"));
    const savedHome = process.env.OP_HOME;
    process.env.OP_HOME = homeDir;

    try {
      const sentinel = new Error("ensureHostPortDefaults-mock-sentinel");
      const ensureHostPortDefaultsMock = mock(async () => {
        // Short-circuit right after the call this test cares about, before
        // performUpgrade needs a real compose stack (image pull, health-wait)
        // to succeed — same technique as the reconcileHostOwnership tests.
        throw sentinel;
      });

      mock.module("./config-persistence.js", () => ({
        ...realConfigPersistence,
        ensureHostPortDefaults: ensureHostPortDefaultsMock,
      }));

      const { performUpgrade, createState } = await import(
        `./lifecycle.js?port-defaults-upgrade-test=${Math.random()}`
      );

      const state = createState();
      await expect(performUpgrade(state)).rejects.toThrow(sentinel.message);

      expect(ensureHostPortDefaultsMock).toHaveBeenCalledTimes(1);
    } finally {
      if (savedHome === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = savedHome;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
