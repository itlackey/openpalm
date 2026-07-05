/**
 * Unit tests for applyStack driven through the DockerClient + FileStore injection
 * seam — NO real docker daemon, NO disk. A fake DockerClient records every
 * invocation and returns canned DockerResults; a fake FileStore answers the
 * compose-arg env-file existence probe.
 *
 * These pin the REAL orchestration rules of the §4.3 / §2.1 compose driver:
 *   (1) pull-before-up ordering (pull is issued strictly before up)
 *   (2) pull failure is FATAL — up is never attempted, failure maps to the scope
 *   (3) health-gate — `up -d --wait` IS the gate; a health-gate failure means
 *       `up` itself exits non-zero, and ONE `compose ps --format json` call
 *       (not a per-container inspect poll) names the failed service
 *   (4) the injected FileStore (not real fs) gates --env-file
 *   (5) a successful `up` needs NO follow-up ps/inspect calls — `--wait`
 *       already confirmed health
 *
 * Before the seam existed, exercising applyStack required a fake `docker` binary
 * on PATH in a subprocess (see apply-stack-service.test.ts). This asserts the
 * same rules in-process against injected doubles.
 */
import { describe, it, expect } from "bun:test";
import {
  applyStack,
  type DockerClient,
  type DockerResult,
  type DockerRunOptions,
  type FileStore,
  type StackDeps,
} from "./docker.js";

function ok(stdout = ""): DockerResult {
  return { ok: true, stdout, stderr: "", code: 0 };
}
function fail(stderr: string, code = 1): DockerResult {
  return { ok: false, stdout: "", stderr, code };
}

class FakeDocker implements DockerClient {
  readonly calls: string[][] = [];
  constructor(private readonly handler: (args: string[]) => DockerResult) {}
  async run(args: string[], _opts?: DockerRunOptions): Promise<DockerResult> {
    this.calls.push(args);
    return this.handler(args);
  }
  indexOfArg(arg: string): number {
    return this.calls.findIndex((c) => c.includes(arg));
  }
  isPsFormatJsonCall(args: string[]): boolean {
    return args.includes("ps") && args.includes("--format") && args.includes("json");
  }
}

/** `compose ps --format json` row: running, no healthcheck ⇒ healthy. */
const HEALTHY_PS_ROW = JSON.stringify({ Service: "assistant", State: "running", Health: "" });
/** Running but explicitly unhealthy. */
const UNHEALTHY_PS_ROW = JSON.stringify({ Service: "assistant", State: "running", Health: "unhealthy" });

function makeFiles(existsCalls: string[]): FileStore {
  return {
    exists: (p: string) => {
      existsCalls.push(p);
      return true;
    },
    read: () => "",
    write: () => {},
  };
}

const OPTS = { files: ["/fake/compose.yml"], envFiles: ["/fake/stack.env"], profiles: [] as string[] };

describe("applyStack — DockerClient + FileStore seam", () => {
  it("(1) pulls the service BEFORE up, with --wait, and reports started with NO follow-up ps/inspect call", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("pull")) return ok();
      if (args.includes("up")) return ok();
      return ok();
    });
    const existsCalls: string[] = [];
    const deps: StackDeps = { docker, files: makeFiles(existsCalls) };

    const result = await applyStack({ kind: "service", service: "assistant" }, OPTS, deps);

    expect(result.ok).toBe(true);
    expect(result.started).toEqual(["assistant"]);
    expect(result.failed).toEqual([]);

    const pullIdx = docker.indexOfArg("pull");
    const upIdx = docker.indexOfArg("up");
    expect(pullIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThan(pullIdx);

    // Scoped recreate flags (§4.3) + the single health gate (§2.1).
    const upCall = docker.calls[upIdx];
    expect(upCall).toContain("--force-recreate");
    expect(upCall).toContain("--no-deps");
    expect(upCall).toContain("assistant");
    expect(upCall).toContain("--wait");
    expect(upCall).toContain("--wait-timeout");
    expect(upCall).not.toContain("--remove-orphans");

    // (5) `--wait` already confirmed health — no per-container ps/inspect call follows a SUCCESSFUL up.
    expect(docker.calls.some((c) => docker.isPsFormatJsonCall(c))).toBe(false);
    expect(docker.indexOfArg("inspect")).toBe(-1);
  });

  it("(4) gates --env-file through the injected FileStore, not real fs", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("pull")) return ok();
      if (args.includes("up")) return ok();
      return ok();
    });
    const existsCalls: string[] = [];
    const deps: StackDeps = { docker, files: makeFiles(existsCalls) };

    await applyStack({ kind: "service", service: "assistant" }, OPTS, deps);

    expect(existsCalls).toContain("/fake/stack.env");
    const pullCall = docker.calls[docker.indexOfArg("pull")];
    expect(pullCall).toContain("--env-file");
    expect(pullCall).toContain("/fake/stack.env");
  });

  it("(2) pull failure is FATAL — up is NEVER attempted and the failure maps to the scope", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("pull")) return fail("pull access denied");
      return ok();
    });
    const deps: StackDeps = { docker, files: makeFiles([]) };

    const result = await applyStack({ kind: "service", service: "guardian" }, OPTS, deps);

    expect(result.ok).toBe(false);
    expect(result.started).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].service).toBe("guardian");
    expect(result.error).toBeTruthy();
    // No `up` was ever issued.
    expect(docker.indexOfArg("up")).toBe(-1);
  });

  it("(3) health-gate: `up --wait` fails, and ONE `compose ps --format json` call names the unhealthy service", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("pull")) return ok();
      if (args.includes("up")) return fail("container assistant is unhealthy");
      if (docker.isPsFormatJsonCall(args)) return ok(UNHEALTHY_PS_ROW);
      return ok();
    });
    const deps: StackDeps = { docker, files: makeFiles([]) };

    const result = await applyStack({ kind: "service", service: "assistant" }, OPTS, deps);

    expect(result.ok).toBe(false);
    expect(result.started).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].service).toBe("assistant");
    expect(result.failed[0].reason).toMatch(/health check/i);

    // Exactly ONE `ps --format json` call — no per-container inspect polling.
    const psCalls = docker.calls.filter((c) => docker.isPsFormatJsonCall(c));
    expect(psCalls).toHaveLength(1);
    expect(docker.indexOfArg("inspect")).toBe(-1);
  });

  it("(3b) partial 'all'-scope failure: the ps rows split healthy from unhealthy services", async () => {
    // scope:"all" targets BOTH assistant and guardian; `up --wait` fails because
    // guardian never became healthy, while assistant's own row is fine. The ONE
    // ps call must attribute the failure to guardian only, not assistant.
    const psRows = [
      JSON.stringify({ Service: "assistant", State: "running", Health: "" }),
      JSON.stringify({ Service: "guardian", State: "running", Health: "unhealthy" }),
    ].join("\n");
    const docker = new FakeDocker((args) => {
      if (args.includes("pull")) return ok();
      if (args.includes("up")) return fail("guardian is unhealthy");
      if (args.includes("config") && args.includes("--services")) return ok("assistant\nguardian\n");
      if (docker.isPsFormatJsonCall(args)) return ok(psRows);
      return ok();
    });
    const deps: StackDeps = { docker, files: makeFiles([]) };

    const result = await applyStack({ kind: "all" }, OPTS, deps);

    expect(result.ok).toBe(false);
    expect(result.started).toEqual(["assistant"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].service).toBe("guardian");
    expect(result.failed[0].reason).toMatch(/health check/i);

    // Exactly ONE `ps --format json` call, still.
    expect(docker.calls.filter((c) => docker.isPsFormatJsonCall(c))).toHaveLength(1);
  });
});
