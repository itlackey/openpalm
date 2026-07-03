/**
 * Vitest global setup — OP_HOME isolation.
 *
 * This file is loaded as a `setupFiles` entry for BOTH the "client" and
 * "server" vitest projects (see vite.config.ts).  It runs before every test
 * file and guarantees:
 *
 *   1. OP_HOME (and OP_WORK_DIR) are pointed at a fresh mkdtemp directory,
 *      unconditionally overriding any ambient value that leaked in from the
 *      shell environment, a .env file, or a previous test run.
 *
 *   2. A tripwire throws if, after our override, OP_HOME is re-pointed at a
 *      real production or dev directory during the test process lifetime (i.e.,
 *      a test set it and forgot to restore).
 *
 * The temp dir is cleaned up in afterAll.  Individual tests may further
 * narrow OP_HOME to per-test sub-dirs — that is fine and encouraged.
 */
import { beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

// ── Forbidden path prefixes ─────────────────────────────────────────────────
// OP_HOME must never resolve to these during a test run.

const FORBIDDEN: string[] = [
  // Real production home
  join(homedir(), ".openpalm"),
  // Repo .dev directory (dev stack data)
  resolve(__dirname, "../../../../.dev"),
  // Guard against ".dev-" variants
  resolve(__dirname, "../../../../.dev-"),
  // Any path under the user's home config dirs
  join(homedir(), ".config"),
  join(homedir(), ".local"),
];

function isForbidden(p: string): boolean {
  try {
    const real = realpathSync(p);
    return FORBIDDEN.some((f) => real === f || real.startsWith(`${f}/`));
  } catch {
    // Path doesn't exist yet — check the string form
    return FORBIDDEN.some((f) => p === f || p.startsWith(`${f}/`));
  }
}

/**
 * Throw if OP_HOME resolves to a protected real directory.
 * Used as a per-test tripwire to catch tests that forgot to restore OP_HOME.
 */
function assertSafeOpHome(value: string | undefined, label: string): void {
  if (!value) return; // unset is fine — we override in beforeAll
  const abs = resolve(value);
  if (isForbidden(abs)) {
    throw new Error(
      `[test-isolation TRIPWIRE] ${label}: OP_HOME="${value}" resolves to a protected directory.\n` +
      `  Resolved: ${abs}\n` +
      `  Tests must never write to ~/.openpalm or .dev. Use a mkdtempSync() temp dir and restore OP_HOME in afterEach.`
    );
  }
}

// ── Suite-level temp dir ────────────────────────────────────────────────────

let suiteTempDir: string | undefined;
let originalOpHome: string | undefined;
let originalOpWorkDir: string | undefined;

beforeAll(() => {
  // Capture whatever was set (possibly .dev from vite.config.ts loading .env)
  originalOpHome = process.env.OP_HOME;
  originalOpWorkDir = process.env.OP_WORK_DIR;

  // Unconditionally override with a safe temp dir — this is the isolation guarantee.
  // We do NOT assert on the original value here; the .env legitimately sets OP_HOME=.dev
  // for the dev server, and we simply replace it for tests.
  suiteTempDir = mkdtempSync(join(tmpdir(), "op-test-"));
  process.env.OP_HOME = suiteTempDir;
  process.env.OP_WORK_DIR = join(suiteTempDir, "workspace");
});

afterAll(() => {
  // Restore env to whatever it was before this suite ran
  if (originalOpHome !== undefined) {
    process.env.OP_HOME = originalOpHome;
  } else {
    delete process.env.OP_HOME;
  }
  if (originalOpWorkDir !== undefined) {
    process.env.OP_WORK_DIR = originalOpWorkDir;
  } else {
    delete process.env.OP_WORK_DIR;
  }

  // Clean up the temp dir
  if (suiteTempDir && existsSync(suiteTempDir)) {
    rmSync(suiteTempDir, { recursive: true, force: true });
  }
  suiteTempDir = undefined;
});

// ── Per-test tripwire ───────────────────────────────────────────────────────
// Some individual tests swap OP_HOME to a per-test sub-dir in beforeEach/afterEach
// which is correct and encouraged.  We re-check after each test to catch any test
// that forgot to restore and left OP_HOME pointing somewhere dangerous.

beforeEach(() => {
  assertSafeOpHome(process.env.OP_HOME, "OP_HOME before test");
});
