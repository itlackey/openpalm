/**
 * Bun test preload — OP_HOME isolation.
 *
 * Loaded via root bunfig.toml [test] preload = [...] for every `bun test`
 * invocation in this repo (lib, cli, guardian, portal-discord, portal-slack).
 *
 * Guarantees:
 *   1. OP_HOME is pointed at a fresh mkdtemp dir, unconditionally overriding
 *      any ambient shell value, .env leakage, or .dev residue — at module top
 *      level, so even code that runs before hooks never sees the ambient value.
 *   2. A tripwire throws if OP_HOME is re-pointed at a real or dev dir during
 *      the test process lifetime (catches tests that forget to restore OP_HOME).
 *   3. The temp dirs are cleaned up after all tests finish.
 *   4. Root installs are opted into (OP_ALLOW_ROOT), because the suite must run
 *      in root environments — CI images, Docker-in-Docker — where the throwaway
 *      OP_HOME above is root-owned and root is the only resolvable operator
 *      identity. Without this the persist-time guard in operator-ids.ts refuses,
 *      which is correct for a real install and wrong for a disposable temp dir.
 *      Only ever set here, never in shipped code.
 */
import { beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The suite runs as root in CI/container images, against a throwaway OP_HOME
// that root necessarily owns. Declare the opt-in the persist-time guard wants
// (see assertRootInstallAllowed) so root environments can run the tests; a real
// install still has to opt in deliberately.
process.env.OP_ALLOW_ROOT = "1";

// ── Repo root detection ─────────────────────────────────────────────────────

const _scriptDir = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

// This script lives at <repo>/scripts/test-isolate-op-home.ts
const REPO_ROOT = resolve(_scriptDir, "..");

// ── Forbidden path prefixes ─────────────────────────────────────────────────

const FORBIDDEN: string[] = [
  join(homedir(), ".openpalm"),
  join(REPO_ROOT, ".dev"),
  join(homedir(), ".config"),
  join(homedir(), ".local"),
];

function isForbidden(p: string): boolean {
  try {
    const real = realpathSync(p);
    return FORBIDDEN.some((f) => real === f || real.startsWith(`${f}/`));
  } catch {
    return FORBIDDEN.some((f) => p === f || p.startsWith(`${f}/`));
  }
}

function assertSafeOpHome(value: string | undefined, label: string): void {
  if (!value) return;
  const abs = resolve(value);
  if (isForbidden(abs)) {
    throw new Error(
      `[test-isolation TRIPWIRE] ${label}: OP_HOME="${value}" resolves to a protected directory.\n` +
      `  Resolved: ${abs}\n` +
      `  Tests must never write to ~/.openpalm or .dev. Use a mkdtempSync() temp dir and restore OP_HOME in afterEach.`
    );
  }
}

// ── Point skeleton asset resolution at the repo for tests ──────────────────
// first, then falls back to OPENPALM_REPO_ROOT. The package is not published yet,
// so we set the env var here (top-level, not inside beforeAll) so it is visible
// before any test module is evaluated. Tests that manage OPENPALM_REPO_ROOT
// themselves save/restore it in their own beforeEach/afterEach.

const originalOpenpalmRepoRoot: string | undefined = process.env.OPENPALM_REPO_ROOT;
if (!originalOpenpalmRepoRoot) {
  process.env.OPENPALM_REPO_ROOT = REPO_ROOT;
}

// ── Process-level neutralization ────────────────────────────────────────────
// Bun auto-loads the repo-root `.env` before this preload runs, and a developer
// .env legitimately sets OP_HOME=.dev for the dev-stack workflows. Overriding
// only in beforeAll is too late: test modules evaluate before hooks fire, so a
// file that captures process.env.OP_HOME at module scope (to restore it later)
// captures the poisoned value and re-exposes it mid-run — which is exactly what
// the tripwire below then catches. Override here, at top level, before any test
// module is evaluated, so no test can ever observe the ambient value.

const processTempDir = mkdtempSync(join(tmpdir(), "op-test-"));
process.env.OP_HOME = processTempDir;
process.env.OP_WORK_DIR = join(processTempDir, "workspace");
process.on("exit", () => {
  rmSync(processTempDir, { recursive: true, force: true });
});

// ── Suite-level temp dir ────────────────────────────────────────────────────

let suiteTempDir: string | undefined;

beforeAll(() => {
  // Unconditionally override — this is the isolation guarantee.
  suiteTempDir = mkdtempSync(join(tmpdir(), "op-test-"));
  process.env.OP_HOME = suiteTempDir;
  process.env.OP_WORK_DIR = join(suiteTempDir, "workspace");
});

afterAll(() => {
  // Restore to the process-level safe dir, NOT the pre-process original: the
  // original may be the developer's .env value (.dev), and putting it back
  // while the process is still running would re-poison later suites.
  process.env.OP_HOME = processTempDir;
  process.env.OP_WORK_DIR = join(processTempDir, "workspace");
  if (originalOpenpalmRepoRoot !== undefined) {
    process.env.OPENPALM_REPO_ROOT = originalOpenpalmRepoRoot;
  } else {
    delete process.env.OPENPALM_REPO_ROOT;
  }

  if (suiteTempDir && existsSync(suiteTempDir)) {
    rmSync(suiteTempDir, { recursive: true, force: true });
  }
  suiteTempDir = undefined;
});

// ── Per-test tripwire ───────────────────────────────────────────────────────
// Fires if a test forgot to restore OP_HOME after pointing it somewhere dangerous.

beforeEach(() => {
  assertSafeOpHome(process.env.OP_HOME, "OP_HOME before test");
});
