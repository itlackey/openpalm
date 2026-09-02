/**
 * writeSystemEnv's operator-id persistence — the root opt-in gate and the
 * standing root warning must judge the EFFECTIVE post-write identity (usable
 * stack.env pins for axes not being written, resolver values for axes that
 * are), not the raw resolver result. A gid-pinned home whose uid backfills to
 * non-root is not a root install; a fully pinned non-root home must not be
 * told its containers will run as 0:0.
 *
 * The mixed-axis scenarios need a root-owned axis from the resolver, so they
 * run only under a root test process (the CI/sandbox case) and no-op
 * elsewhere — the same style of environment guard as the win32 early returns
 * in operator-ids.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "./lifecycle.js";
import { writeSystemEnv } from "./config-persistence.js";
import { parseEnvContent } from "./env.js";

let homeDir: string;
let savedHome: string | undefined;
let savedAllowRoot: string | undefined;

function isRootProcess(): boolean {
  return process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Root-only assertions in this file silently ran ZERO assertions on every CI
 * run: `if (!isRootProcess()) return;` no-ops on an unprivileged process, and
 * ci.yml's `bun run test` has always run unprivileged (#653). That made these
 * three tests decorative — they always "passed" by asserting nothing.
 *
 * The CI root lane (a `sudo -E env "PATH=$PATH" bun test` run — see
 * scripts/cross-uid-smoke.sh's sibling CI step) sets OP_REQUIRE_ROOT_TESTS=1
 * so a regression that lands the suite back on an unprivileged runner FAILS
 * LOUDLY instead of quietly no-op'ing again. Every other (non-root) run of
 * this file — the ordinary `bun run test` lane — leaves the var unset and
 * keeps the original skip-on-non-root behavior.
 */
function requireRootOrSkip(): boolean {
  if (isRootProcess()) return true;
  if (process.env.OP_REQUIRE_ROOT_TESTS === "1") {
    throw new Error(
      "OP_REQUIRE_ROOT_TESTS=1 but this test process is not root " +
        `(uid=${typeof process.getuid === "function" ? process.getuid() : "unavailable"}) — ` +
        "the root-only mixed-identity assertions in this file cannot run. This file must be " +
        'executed as root (e.g. `sudo -E env "PATH=$PATH" bun test --isolate ' +
        "packages/lib/src/control-plane/config-persistence-operator-ids.test.ts`).",
    );
  }
  return false;
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "openpalm-opids-persist-"));
  savedHome = process.env.OP_HOME;
  savedAllowRoot = process.env.OP_ALLOW_ROOT;
  process.env.OP_HOME = homeDir;
  mkdirSync(join(homeDir, "knowledge", "env"), { recursive: true });
  mkdirSync(join(homeDir, "state"), { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = savedHome;
  if (savedAllowRoot === undefined) delete process.env.OP_ALLOW_ROOT;
  else process.env.OP_ALLOW_ROOT = savedAllowRoot;
  rmSync(homeDir, { recursive: true, force: true });
});

function readStackEnvFile(): Record<string, string> {
  return parseEnvContent(readFileSync(join(homeDir, "state", "stack.env"), "utf-8"));
}

describe("writeSystemEnv — effective operator identity", () => {
  it("a non-root OP_GID pin plus a uid backfill passes the gate — the effective identity is non-root", () => {
    if (!requireRootOrSkip()) return;
    delete process.env.OP_ALLOW_ROOT;
    // Home owned 4242:0 under a root process: resolveOperatorIds gives the
    // mixed {4242, 0}. Only OP_UID would be written (OP_GID is pinned), so
    // the post-write identity is 4242:4242 — fully non-root, no opt-in needed.
    chownSync(homeDir, 4242, 0);
    writeFileSync(join(homeDir, "state", "stack.env"), `OP_HOME=${homeDir}\nOP_GID=4242\n`);
    const state = createState();

    expect(() => writeSystemEnv(state)).not.toThrow();

    const env = readStackEnvFile();
    expect(env.OP_UID).toBe("4242");
    expect(env.OP_GID).toBe("4242");
  });

  it("does not warn 'containers will run as 0:0' when non-root pins cover the root axes", () => {
    if (!requireRootOrSkip()) return;
    delete process.env.OP_ALLOW_ROOT;
    // Root-owned home + root process resolve {0, 0}, but both axes are pinned
    // non-root, so nothing root is written OR effective: no gate, no warning.
    writeFileSync(
      join(homeDir, "state", "stack.env"),
      `OP_HOME=${homeDir}\nOP_UID=4242\nOP_GID=4242\n`,
    );
    const state = createState();
    // logger.warn serializes to console.error — capture it to see the warning.
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => writeSystemEnv(state)).not.toThrow();
      const warned = spy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(warned).not.toContain("containers will run as");
    } finally {
      spy.mockRestore();
    }

    const env = readStackEnvFile();
    expect(env.OP_UID).toBe("4242");
    expect(env.OP_GID).toBe("4242");
  });

  it("still refuses to PERSIST a root identity without the opt-in", () => {
    if (!requireRootOrSkip()) return;
    delete process.env.OP_ALLOW_ROOT;
    // No pins at all: both axes would be written from the root resolution.
    writeFileSync(join(homeDir, "state", "stack.env"), `OP_HOME=${homeDir}\n`);
    const state = createState();

    expect(() => writeSystemEnv(state)).toThrow(/OP_ALLOW_ROOT=1/);
  });
});
