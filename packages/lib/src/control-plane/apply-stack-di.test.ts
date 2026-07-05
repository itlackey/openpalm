/**
 * Unit tests for applyStack driven through the DockerClient + FileStore injection
 * seam — NO real docker daemon, NO disk. A fake DockerClient records every
 * invocation and returns canned DockerResults; a fake FileStore answers the
 * compose-arg env-file existence probe.
 *
 * These pin the REAL orchestration rules of the §4.3 compose driver (plan 2.2 —
 * single `up --pull missing` call, no separate `pull` step):
 *   (1) ONE `up --pull missing --force-recreate` call — no separate pull
 *   (2) that call failing is FATAL — failure maps to the scope, nothing started
 *   (3) health-gate — a running-but-unhealthy container fails the service
 *   (4) the injected FileStore (not real fs) gates --env-file
 *   (5) kind:'all' additionally carries --remove-orphans (#450)
 *   (6) progress hooks (onService, healthTimeoutMs) are optional and, when
 *       provided, fire pending→terminal per service
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
  it("(1) issues ONE up --pull missing call (no separate pull), and reports started on a healthy container", async () => {
    const docker = new FakeDocker((args) => {
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

    // No separate `pull` subcommand call at all — --pull missing is folded into `up`.
    expect(docker.calls).toHaveLength(3); // up, ps -q, inspect
    const bareCall = docker.calls.find((c) => c.includes("pull") && !c.includes("--pull"));
    expect(bareCall).toBeUndefined();

    const upIdx = docker.indexOfArg("up");
    expect(upIdx).toBeGreaterThanOrEqual(0);

    // Scoped recreate flags (§4.3) + the merged pull policy.
    const upCall = docker.calls[upIdx];
    expect(upCall).toContain("--pull");
    expect(upCall).toContain("missing");
    expect(upCall).toContain("--force-recreate");
    expect(upCall).toContain("--no-deps");
    expect(upCall).toContain("assistant");
    expect(upCall).not.toContain("--remove-orphans");
  });

  it("(4) gates --env-file through the injected FileStore, not real fs", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("up")) return ok();
      if (args.includes("ps") && args.includes("-q")) return ok("container-123");
      if (args.includes("inspect")) return ok(HEALTHY_INSPECT);
      return ok();
    });
    const existsCalls: string[] = [];
    const deps: StackDeps = { docker, files: makeFiles(existsCalls) };

    await applyStack({ kind: "service", service: "assistant" }, OPTS, deps);

    expect(existsCalls).toContain("/fake/stack.env");
    const upCall = docker.calls[docker.indexOfArg("up")];
    expect(upCall).toContain("--env-file");
    expect(upCall).toContain("/fake/stack.env");
  });

  it("(2) an up failure (e.g. the folded pull failing because the pin is missing) is FATAL " +
    "and maps to the scope", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("up")) return fail("pull access denied");
      return ok();
    });
    const deps: StackDeps = { docker, files: makeFiles([]) };

    const result = await applyStack({ kind: "service", service: "guardian" }, OPTS, deps);

    expect(result.ok).toBe(false);
    expect(result.started).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].service).toBe("guardian");
    expect(result.error).toBeTruthy();
    // No ps/inspect health-check calls — up never succeeded.
    expect(docker.calls.some((c) => c.includes("inspect"))).toBe(false);
  });

  it("(5) kind:'all' issues up with --pull missing --force-recreate --remove-orphans, so an " +
    "unchanged-config container still restarts onto a newly pulled image (#450 — verified precisely by 2.2)", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("up")) return ok();
      return ok();
    });
    const deps: StackDeps = { docker, files: makeFiles([]) };

    await applyStack({ kind: "all" }, OPTS, deps);

    const upCall = docker.calls[docker.indexOfArg("up")];
    expect(upCall).toBeTruthy();
    expect(upCall).toContain("--pull");
    expect(upCall).toContain("missing");
    expect(upCall).toContain("--remove-orphans");
    expect(upCall).toContain("--force-recreate");
  });

  it("(3) health-gate: a running-but-unhealthy container fails the service", async () => {
    const docker = new FakeDocker((args) => {
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

  it("(6) progress hooks fire pending→running per service, and honor healthTimeoutMs", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("up")) return ok();
      if (args.includes("ps") && args.includes("-q")) return ok("container-123");
      if (args.includes("inspect")) return ok(HEALTHY_INSPECT);
      return ok();
    });
    const deps: StackDeps = { docker, files: makeFiles([]) };
    const events: Array<[string, string, string]> = [];

    const result = await applyStack(
      { kind: "service", service: "assistant" },
      OPTS,
      deps,
      { onService: (service, status, detail) => events.push([service, status, detail]), healthTimeoutMs: 5_000 },
    );

    expect(result.ok).toBe(true);
    expect(events[0]).toEqual(["assistant", "pending", "Starting..."]);
    expect(events[1]).toEqual(["assistant", "running", "Running"]);
  });

  it("(6) progress hooks are optional — omitting them changes nothing", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("up")) return ok();
      if (args.includes("ps") && args.includes("-q")) return ok("container-123");
      if (args.includes("inspect")) return ok(HEALTHY_INSPECT);
      return ok();
    });
    const deps: StackDeps = { docker, files: makeFiles([]) };

    const result = await applyStack({ kind: "service", service: "assistant" }, OPTS, deps);
    expect(result.ok).toBe(true);
  });
});
