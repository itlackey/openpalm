/**
 * Lib-level tests for applyStack({ kind: "service" }) — the scoped single-service
 * update scope (constitution §4, §7 "updating one container MUST NOT touch others").
 *
 * Asserts:
 *   (a) pull is issued WITH the service name arg (not the whole stack)
 *   (b) up is issued WITH --force-recreate --no-deps <service> (scoped recreate)
 *   (c) health-check polls only that one service (targetServices = [service])
 *   (d) pull failure is FATAL: up is NOT attempted, failed[0].service === service
 *
 * Uses a fake docker shell script on PATH to intercept and record calls without
 * a running Docker daemon — no subprocess harness needed, no mock.module trickery.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// ── Fake-docker harness ───────────────────────────────────────────────────────
//
// A tiny shell script that: records all invocations to a log file,
// returns sensible output for each compose/inspect subcommand, and
// optionally fails pull when FAKE_DOCKER_PULL_FAIL=1.

let fakeBinDir: string;
let callLogPath: string;

// Shell script lines joined with newlines (avoids Bun mis-parsing ${...} shell syntax).
const FAKE_DOCKER_SCRIPT = [
  "#!/bin/sh",
  // Record all args to the call log
  'echo "$@" >> "$FAKE_DOCKER_CALL_LOG"',
  // inspect -> tab-delimited state/digest/image/health (running, no healthcheck = healthy)
  'if echo "$@" | grep -q "inspect"; then',
  '  printf "running\\topenpalm/assistant:latest\\topenpalm/assistant:latest\\t\\n"',
  "  exit 0",
  "fi",
  // compose ps -q <svc> -> container ID
  'if echo "$@" | grep -q -- "-q"; then',
  '  echo "abc123"',
  "  exit 0",
  "fi",
  // pull -> fail when FAKE_DOCKER_PULL_FAIL=1
  'if echo "$@" | grep -q "pull"; then',
  '  if [ "${FAKE_DOCKER_PULL_FAIL:-0}" = "1" ]; then',
  '    echo "pull access denied" >&2',
  "    exit 1",
  "  fi",
  "  exit 0",
  "fi",
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
  opts?: { pullFail?: boolean },
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
  it("(a) issues pull with the service name arg (not the whole stack)", () => {
    const { calls } = runApplyStack({ kind: "service", service: "assistant" });
    const pullCall = calls.find((c) => /\bpull\b/.test(c));
    expect(pullCall, `pull call not found in: ${JSON.stringify(calls)}`).toBeTruthy();
    expect(pullCall).toContain("assistant");
    // Must NOT be a bare `pull` (which would pull all images)
    // The pull args end with the service name, not empty.
    expect(pullCall!.trim().endsWith("assistant")).toBe(true);
  });

  it("(b) issues up with --force-recreate --no-deps <service> (not --remove-orphans)", () => {
    const { calls } = runApplyStack({ kind: "service", service: "assistant" });
    const upCall = calls.find((c) => /\bup\b/.test(c));
    expect(upCall, `up call not found in: ${JSON.stringify(calls)}`).toBeTruthy();
    expect(upCall).toContain("--force-recreate");
    expect(upCall).toContain("--no-deps");
    expect(upCall).toContain("assistant");
    // --remove-orphans is for kind:"all" only
    expect(upCall).not.toContain("--remove-orphans");
  });

  it("(c) health-checks only the scoped service (ps -q <service>)", () => {
    const { calls } = runApplyStack({ kind: "service", service: "assistant" });
    const psCall = calls.find((c) => /\bps\b/.test(c) && c.includes("-q"));
    expect(psCall, `ps -q call not found in: ${JSON.stringify(calls)}`).toBeTruthy();
    expect(psCall).toContain("assistant");
    // Only one ps call — not iterating over multiple services
    const psCalls = calls.filter((c) => /\bps\b/.test(c) && c.includes("-q"));
    expect(psCalls).toHaveLength(1);
  });

  it("(c) reports ok:true with started=['assistant'] on success", () => {
    const { result } = runApplyStack({ kind: "service", service: "assistant" });
    expect(result.ok).toBe(true);
    expect(result.started).toEqual(["assistant"]);
    expect(result.failed).toEqual([]);
  });

  it("(d) pull failure is FATAL: up is NOT called, failed[0].service === service", () => {
    const { result, calls } = runApplyStack({ kind: "service", service: "guardian" }, { pullFail: true });
    expect(result.ok).toBe(false);
    expect(result.started).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].service).toBe("guardian");

    // up must NOT have been called when pull failed
    const upCall = calls.find((c) => /\bup\b/.test(c));
    expect(upCall, "up must NOT be called after pull failure").toBeUndefined();
  });
});
