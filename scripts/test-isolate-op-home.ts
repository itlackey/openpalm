/**
 * Bun test preload — OP_HOME isolation.
 *
 * Loaded via root bunfig.toml [test] preload = [...] for every `bun test`
 * invocation in this repo (lib, cli, guardian, channels-sdk, channel-*).
 *
 * Guarantees:
 *   1. OP_HOME is pointed at a fresh mkdtemp dir, unconditionally overriding
 *      any ambient shell value, .env leakage, or .dev residue.
 *   2. A tripwire throws if OP_HOME is re-pointed at a real or dev dir during
 *      the test process lifetime (catches tests that forget to restore OP_HOME).
 *   3. The temp dir is cleaned up after all tests finish.
 */
import { beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    return FORBIDDEN.some((f) => real === f || real.startsWith(f + "/"));
  } catch {
    return FORBIDDEN.some((f) => p === f || p.startsWith(f + "/"));
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

// ── Suite-level temp dir ────────────────────────────────────────────────────

let suiteTempDir: string | undefined;
const originalOpHome: string | undefined = process.env.OP_HOME;
const originalOpWorkDir: string | undefined = process.env.OP_WORK_DIR;

beforeAll(() => {
  // Unconditionally override — this is the isolation guarantee.
  suiteTempDir = mkdtempSync(join(tmpdir(), "op-test-"));
  process.env.OP_HOME = suiteTempDir;
  process.env.OP_WORK_DIR = join(suiteTempDir, "workspace");
});

afterAll(() => {
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
