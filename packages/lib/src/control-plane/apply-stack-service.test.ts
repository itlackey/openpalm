/**
 * Lib-level tests for applyStack({ kind: "service" }) — the scoped single-service
 * update scope (constitution §4, §7 "updating one container MUST NOT touch others").
 *
 * Asserts:
 *   (a) ONE `up --pull <mode>` invocation scoped to the service (no separate
 *       pull command, no whole-stack pull)
 *   (b) up is issued WITH --force-recreate --no-deps <service> --wait (scoped
 *       recreate + §2.1's single health gate)
 *   (c) a SUCCESSFUL up needs NO follow-up ps/inspect call — `--wait` already
 *       confirmed health
 *   (d) a pull failure surfaced by `up` is FATAL: failed[0].service === service
 *   (e) a FAILED up (the §2.1 health gate) triggers exactly ONE
 *       `ps --format json` call that names the failed service
 *
 * Uses a fake docker shell script on PATH to intercept and record calls without
 * a running Docker daemon — no subprocess harness needed, no mock.module trickery.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// ── Fake-docker harness ───────────────────────────────────────────────────────
//
// A tiny shell script that: records all invocations to a log file,
// returns sensible output for each compose subcommand, and optionally fails
// pull (FAKE_DOCKER_PULL_FAIL=1) or up (FAKE_DOCKER_UP_FAIL=1, simulating a
// `--wait` health-gate failure).

let fakeBinDir: string;
let callLogPath: string;

// Shell script lines joined with newlines (avoids Bun mis-parsing ${...} shell syntax).
const FAKE_DOCKER_SCRIPT = [
  "#!/bin/sh",
  // Record all args to the call log
  'echo "$@" >> "$FAKE_DOCKER_CALL_LOG"',
  // compose ps --format json -> one row (configurable via FAKE_DOCKER_PS_ROWS,
  // newline-separated JSON lines; default: a single healthy "assistant" row).
  'case "$*" in',
  '  *"ps --format json"*)',
  '    if [ -n "$FAKE_DOCKER_PS_ROWS" ]; then',
  '      printf "%s\\n" "$FAKE_DOCKER_PS_ROWS"',
  "    else",
  '      echo \'{"Service":"assistant","State":"running","Health":""}\'',
  "    fi",
  "    exit 0",
  "    ;;",
  "esac",
  // up -> the SINGLE driver call (it carries `--pull <mode>`, plan 2.2). Fails
  // with a pull-denied message when FAKE_DOCKER_PULL_FAIL=1 (the in-`up` pull is
  // fatal) or with a health message when FAKE_DOCKER_UP_FAIL=1 (a --wait
  // health-gate failure).
  'case "$*" in',
  '  *" up -d "*)',
  '    if [ "${FAKE_DOCKER_PULL_FAIL:-0}" = "1" ]; then',
  '      echo "pull access denied" >&2',
  "      exit 1",
  "    fi",
  '    if [ "${FAKE_DOCKER_UP_FAIL:-0}" = "1" ]; then',
  '      echo "up failed: container is unhealthy" >&2',
  "      exit 1",
  "    fi",
  "    exit 0",
  "    ;;",
  "esac",
  "exit 0",
].join("\n");

beforeAll(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), "op-fake-docker-"));
  const dockerBin = join(fakeBinDir, "docker");
  callLogPath = join(fakeBinDir, "calls.log");
  writeFileSync(dockerBin, FAKE_DOCKER_SCRIPT);
  chmodSync(dockerBin, 0o755);
});

afterAll(() => {
  if (fakeBinDir) rmSync(fakeBinDir, { recursive: true, force: true });
});

function readCalls(): string[] {
  try {
    return readFileSync(callLogPath, "utf-8").split("\n").filter(Boolean);
  } catch { return []; }
}

function clearCallLog(): void {
  try { writeFileSync(callLogPath, ""); } catch { /* ok */ }
}

/** Run applyStack in a subprocess with the fake docker on PATH. */
function runApplyStack(
  scope: { kind: "service"; service: string } | { kind: "all" },
  opts?: { pullFail?: boolean; upFail?: boolean; psRows?: string[] },
): { result: { ok: boolean; started: string[]; failed: { service: string; reason: string }[] }; calls: string[] } {
  const callLog = callLogPath;
  const script = `
const { applyStack } = await import(${JSON.stringify(new URL("./docker.js", import.meta.url).href)});
const opts = { files: ['/tmp/fake/compose.yml'], envFiles: [], profiles: [] };
const result = await applyStack(${JSON.stringify(scope)}, opts);
console.log(JSON.stringify(result));
`;
  const tmp = mkdtempSync(join(tmpdir(), "op-apply-stack-test-"));
  const scriptPath = join(tmp, "run.ts");
  writeFileSync(scriptPath, script);

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: `${fakeBinDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    FAKE_DOCKER_CALL_LOG: callLog,
    OP_SKIP_COMPOSE_PREFLIGHT: "1",
  };
  if (opts?.pullFail) env.FAKE_DOCKER_PULL_FAIL = "1";
  if (opts?.upFail) env.FAKE_DOCKER_UP_FAIL = "1";
  if (opts?.psRows) env.FAKE_DOCKER_PS_ROWS = opts.psRows.join("\n");

  clearCallLog();
  const out = spawnSync("bun", ["run", "--smol", scriptPath], {
    env,
    timeout: 30_000,
  });
  rmSync(tmp, { recursive: true, force: true });

  let result: { ok: boolean; started: string[]; failed: { service: string; reason: string }[] };
  try {
    const line = (out.stdout?.toString() ?? "").trim().split("\n").filter(l => l.startsWith("{")).at(-1) ?? "{}";
    result = JSON.parse(line);
  } catch {
    throw new Error(
      `Could not parse stdout:\n${out.stdout?.toString()}\n\nstderr:\n${out.stderr?.toString()}`
    );
  }
  return { result, calls: readCalls() };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("applyStack({ kind: 'service' }) — scoped single-service update", () => {
  it("(a) issues ONE `up --pull` scoped to the service (no separate pull, no whole-stack pull)", () => {
    const { calls } = runApplyStack({ kind: "service", service: "assistant" });
    // The single driver call carries `--pull` inline (plan 2.2) and is scoped
    // to the service — there is NO separate `pull` command.
    const upCall = calls.find((c) => /\bup\b/.test(c));
    expect(upCall, `up call not found in: ${JSON.stringify(calls)}`).toBeTruthy();
    expect(upCall).toContain("--pull");
    expect(upCall).toContain("--no-deps");
    expect(upCall?.trim().endsWith("assistant")).toBe(true);
    expect(calls.some((c) => /\bpull\b/.test(c) && !/\bup\b/.test(c))).toBe(false);
  });

  it("(b) issues up with --force-recreate --no-deps <service> --wait (not --remove-orphans)", () => {
    const { calls } = runApplyStack({ kind: "service", service: "assistant" });
    const upCall = calls.find((c) => /\bup\b/.test(c));
    expect(upCall, `up call not found in: ${JSON.stringify(calls)}`).toBeTruthy();
    expect(upCall).toContain("--force-recreate");
    expect(upCall).toContain("--no-deps");
    expect(upCall).toContain("assistant");
    // §2.1: --wait/--wait-timeout is the single health gate on every `up`.
    expect(upCall).toContain("--wait");
    expect(upCall).toContain("--wait-timeout");
    // --remove-orphans is for kind:"all" only
    expect(upCall).not.toContain("--remove-orphans");
  });

  it("(c) reports ok:true with started=['assistant'] on success, with NO follow-up ps/inspect call", () => {
    const { result, calls } = runApplyStack({ kind: "service", service: "assistant" });
    expect(result.ok).toBe(true);
    expect(result.started).toEqual(["assistant"]);
    expect(result.failed).toEqual([]);

    // §2.1: `--wait` already confirmed health — no per-container poll follows a
    // successful up.
    expect(calls.some((c) => c.includes("ps --format json"))).toBe(false);
    expect(calls.some((c) => /\binspect\b/.test(c))).toBe(false);
  });

  it("(d) a pull failure surfaced by up is FATAL and maps to the scope", () => {
    const { result, calls } = runApplyStack({ kind: "service", service: "guardian" }, { pullFail: true });
    expect(result.ok).toBe(false);
    expect(result.started).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].service).toBe("guardian");
    expect(result.upFailed).toBe(true);

    // The up (which carries `--pull`) IS the single invocation — there is no
    // separate `pull` command to have failed first.
    expect(calls.some((c) => /\bpull\b/.test(c) && !/\bup\b/.test(c))).toBe(false);
  });

  it("(e) a FAILED up (§2.1 health gate) triggers exactly ONE `ps --format json` call naming the failed service", () => {
    const { result, calls } = runApplyStack(
      { kind: "service", service: "assistant" },
      { upFail: true, psRows: ['{"Service":"assistant","State":"running","Health":"unhealthy"}'] },
    );
    expect(result.ok).toBe(false);
    expect(result.started).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].service).toBe("assistant");

    const psCalls = calls.filter((c) => c.includes("ps --format json"));
    expect(psCalls).toHaveLength(1);
    expect(calls.some((c) => /\binspect\b/.test(c))).toBe(false);
  });
});
