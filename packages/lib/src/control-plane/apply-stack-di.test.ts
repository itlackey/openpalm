/**
 * Unit tests for applyStack driven through the DockerClient + FileStore injection
 * seam — NO real docker daemon, NO disk. A fake DockerClient records every
 * invocation and returns canned DockerResults; a fake FileStore answers the
 * compose-arg env-file existence probe.
 *
 * These pin the REAL orchestration rules of the §4.3 compose driver:
 *   (1) pull-before-up ordering (pull is issued strictly before up)
 *   (2) pull failure is FATAL — up is never attempted, failure maps to the scope
 *   (3) health-gate — a running-but-unhealthy container fails the service
 *   (4) the injected FileStore (not real fs) gates --env-file
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
}

/** Health-inspect line: running container with no healthcheck ⇒ healthy. */
const HEALTHY_INSPECT = "running\topenpalm/assistant:latest\topenpalm/assistant:latest\t";
/** Running but explicitly unhealthy. */
const UNHEALTHY_INSPECT = "running\topenpalm/assistant:latest\topenpalm/assistant:latest\tunhealthy";

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
  it("(1) pulls the service BEFORE up, and reports started on a healthy container", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("pull")) return ok();
      if (args.includes("up")) return ok();
      if (args.includes("ps") && args.includes("-q")) return ok("container-123");
      if (args.includes("inspect")) return ok(HEALTHY_INSPECT);
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

    // Scoped recreate flags (§4.3).
    const upCall = docker.calls[upIdx];
    expect(upCall).toContain("--force-recreate");
    expect(upCall).toContain("--no-deps");
    expect(upCall).toContain("assistant");
    expect(upCall).not.toContain("--remove-orphans");
  });

  it("(4) gates --env-file through the injected FileStore, not real fs", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("pull")) return ok();
      if (args.includes("up")) return ok();
      if (args.includes("ps") && args.includes("-q")) return ok("container-123");
      if (args.includes("inspect")) return ok(HEALTHY_INSPECT);
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

  it("(3) health-gate: a running-but-unhealthy container fails the service", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("pull")) return ok();
      if (args.includes("up")) return ok();
      if (args.includes("ps") && args.includes("-q")) return ok("container-123");
      if (args.includes("inspect")) return ok(UNHEALTHY_INSPECT);
      return ok();
    });
    const deps: StackDeps = { docker, files: makeFiles([]) };

    const result = await applyStack({ kind: "service", service: "assistant" }, OPTS, deps);

    expect(result.ok).toBe(false);
    expect(result.started).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].service).toBe("assistant");
    expect(result.failed[0].reason).toContain("unhealthy");
  });
});
