import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration tests for the scheduler co-process.
 *
 * The server has no HTTP layer anymore — it is driven entirely through the
 * filesystem. These tests spawn the server in a subprocess and verify that
 * dropping a sentinel file under `${OP_HOME}/data/scheduler/triggers/` causes
 * the named automation to fire and the sentinel to be removed.
 */

const TEST_DIR = join(tmpdir(), `scheduler-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const AUTOMATIONS_DIR = join(TEST_DIR, "config", "automations");
const TRIGGERS_DIR = join(TEST_DIR, "data", "scheduler", "triggers");
const TOUCH_FILE = join(TEST_DIR, "fired.txt");

// Shell automation that creates a sentinel file when executed so the test
// can observe "this ran" without depending on the network.
const SHELL_AUTOMATION = `
name: server-test
description: Fires a shell command that touches a marker file
schedule: "0 0 1 1 *"
enabled: true
action:
  type: shell
  command:
    - sh
    - -c
    - 'echo fired > ${TOUCH_FILE}'
on_failure: log
`;

let serverProc: ReturnType<typeof Bun.spawn> | null = null;

function waitFor(predicate: () => boolean, maxMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (predicate()) {
        clearInterval(iv);
        resolve();
        return;
      }
      if (Date.now() - start > maxMs) {
        clearInterval(iv);
        reject(new Error(`Condition not met within ${maxMs}ms`));
      }
    }, 50);
  });
}

beforeAll(async () => {
  mkdirSync(AUTOMATIONS_DIR, { recursive: true });
  mkdirSync(TRIGGERS_DIR, { recursive: true });
  writeFileSync(join(AUTOMATIONS_DIR, "server-test.yml"), SHELL_AUTOMATION);

  serverProc = Bun.spawn(["bun", "run", join(__dirname, "main.ts")], {
    env: {
      ...process.env,
      OP_HOME: TEST_DIR,
      OP_ASSISTANT_TOKEN: "test-assistant-token",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Give the scheduler a moment to start, load automations, and attach the
  // sentinel watcher. There is no health endpoint to poll.
  await new Promise((r) => setTimeout(r, 1500));
});

afterAll(() => {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("scheduler co-process", () => {
  it("fires the automation when a sentinel file appears", async () => {
    expect(existsSync(TOUCH_FILE)).toBe(false);

    writeFileSync(join(TRIGGERS_DIR, "server-test.yml.run"), "");

    await waitFor(() => existsSync(TOUCH_FILE), 5000);
    expect(existsSync(TOUCH_FILE)).toBe(true);
  });

  it("removes the sentinel after firing", async () => {
    // Wait until the trigger directory is empty (the sentinel from the
    // previous test was unlinked synchronously when the event fired).
    await waitFor(
      () => readdirSync(TRIGGERS_DIR).filter((f) => f.endsWith(".run")).length === 0,
      5000,
    );
    expect(readdirSync(TRIGGERS_DIR).filter((f) => f.endsWith(".run"))).toEqual([]);
  });

  it("ignores sentinels that do not match a loaded automation", async () => {
    const unknownSentinel = join(TRIGGERS_DIR, "nonexistent.yml.run");
    writeFileSync(unknownSentinel, "");

    // The sentinel is still removed (so it doesn't linger and re-fire) but
    // no automation runs. We give it time to be processed.
    await waitFor(() => !existsSync(unknownSentinel), 5000);
    expect(existsSync(unknownSentinel)).toBe(false);
  });

  it("de-duplicates concurrent sentinels for the same automation", async () => {
    // Drop a slow shell automation that takes ~2 seconds to complete and
    // appends a single line to a counter file each time it fires.
    const counterFile = join(TEST_DIR, "slow-counter.txt");
    rmSync(counterFile, { force: true });

    const slowAutomation = `
name: slow-test
description: Slow shell automation used to verify de-dupe
schedule: "0 0 1 1 *"
enabled: true
action:
  type: shell
  command:
    - sh
    - -c
    - 'sleep 2 && echo fired >> ${counterFile}'
on_failure: log
`;
    writeFileSync(join(AUTOMATIONS_DIR, "slow-test.yml"), slowAutomation);

    // Give the watcher a moment to pick up the new automation.
    await new Promise((r) => setTimeout(r, 1500));

    // Drop two sentinels in rapid succession. inFlightTriggers should
    // collapse them into a single execution.
    writeFileSync(join(TRIGGERS_DIR, "slow-test.yml.run"), "");
    // Tiny delay so fs.watch reliably fires twice (once per write).
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(TRIGGERS_DIR, "slow-test.yml.run"), "");

    // Wait long enough for the slow automation to finish.
    await waitFor(() => existsSync(counterFile), 8000);
    // Give any (incorrect) second run a chance to also complete.
    await new Promise((r) => setTimeout(r, 3000));

    const content = readFileSync(counterFile, "utf-8");
    const fireCount = content.split("\n").filter((line) => line === "fired").length;
    expect(fireCount).toBe(1);
  }, 15000);

  it("picks up new automations dropped into config/automations (hot reload)", async () => {
    const hotTouch = join(TEST_DIR, "hot-fired.txt");
    rmSync(hotTouch, { force: true });

    const hotAutomation = `
name: hot-reload-test
description: Verifies hot reload through the subprocess
schedule: "0 0 1 1 *"
enabled: true
action:
  type: shell
  command:
    - sh
    - -c
    - 'echo hot > ${hotTouch}'
on_failure: log
`;
    writeFileSync(join(AUTOMATIONS_DIR, "hot-reload-test.yml"), hotAutomation);

    // Wait for the file watcher debounce + reload (the scheduler uses a
    // short debounce in startWatching). 2.5s comfortably exceeds it.
    await new Promise((r) => setTimeout(r, 2500));

    writeFileSync(join(TRIGGERS_DIR, "hot-reload-test.yml.run"), "");
    await waitFor(() => existsSync(hotTouch), 5000);
    expect(existsSync(hotTouch)).toBe(true);
  }, 10000);

  it("shuts down cleanly on SIGTERM", async () => {
    // Spawn a fresh subprocess so the afterAll teardown still has the
    // primary subprocess available (and so this test is independent of
    // any prior state).
    const proc = Bun.spawn(["bun", "run", join(__dirname, "main.ts")], {
      env: {
        ...process.env,
        OP_HOME: TEST_DIR,
        OP_ASSISTANT_TOKEN: "test-assistant-token",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Give it time to fully boot.
    await new Promise((r) => setTimeout(r, 1000));

    proc.kill("SIGTERM");

    const exitedWithin = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);

    expect(exitedWithin).toBe(true);
    expect(proc.exitCode).toBe(0);
  }, 8000);
});
