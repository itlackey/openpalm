import { describe, expect, test } from "bun:test";
import {
  applyStack,
  type DockerClient,
  type DockerResult,
  type StackDeps,
} from "./docker.js";

const OPTIONS = {
  files: ["/fake/compose.yml"],
  envFiles: ["/fake/stack.env"],
  profiles: ["addon.discord"],
};

function result(ok: boolean, stderr = ""): DockerResult {
  return { ok, stdout: "", stderr, code: ok ? 0 : 1 };
}

class FakeDocker implements DockerClient {
  readonly calls: string[][] = [];

  constructor(private readonly respond: (args: string[]) => DockerResult = () => result(true)) {}

  async run(args: string[]): Promise<DockerResult> {
    this.calls.push(args);
    return this.respond(args);
  }
}

function deps(docker: FakeDocker): StackDeps {
  return { docker, fileExists: () => true };
}

describe("applyStack", () => {
  test("pulls the complete stack before one apply", async () => {
    const docker = new FakeDocker();

    const applied = await applyStack({ kind: "all" }, OPTIONS, deps(docker), { pull: "always" });

    expect(applied.ok).toBe(true);
    expect(docker.calls).toHaveLength(3);
    expect(docker.calls[0]).toContain("pull");
    expect(docker.calls[1]).toContain("up");
    expect(docker.calls[1]).toContain("--remove-orphans");
    expect(docker.calls[2]).toEqual(expect.arrayContaining(["config", "--services"]));
  });

  test("pulls and force-recreates only one service", async () => {
    const docker = new FakeDocker();

    await applyStack(
      { kind: "service", service: "assistant" },
      OPTIONS,
      deps(docker),
      { pull: "always" },
    );

    expect(docker.calls).toHaveLength(2);
    expect(docker.calls[0]).toEqual(expect.arrayContaining(["pull", "assistant"]));
    expect(docker.calls[1]).toEqual(
      expect.arrayContaining(["up", "--force-recreate", "--no-deps", "assistant"]),
    );
    expect(docker.calls[1]).not.toContain("--remove-orphans");
  });

  test("does not mutate containers when pull fails", async () => {
    const docker = new FakeDocker((args) =>
      args.includes("pull") ? result(false, "manifest unknown: openpalm/assistant:bad") : result(true),
    );

    const applied = await applyStack(
      { kind: "service", service: "assistant" },
      OPTIONS,
      deps(docker),
      { pull: "always" },
    );

    expect(applied.ok).toBe(false);
    expect(applied.pullFailed).toBe(true);
    expect(applied.error).toContain("manifest");
    expect(docker.calls).toHaveLength(1);
  });

  test("surfaces an apply failure after a successful pull", async () => {
    const docker = new FakeDocker((args) =>
      args.includes("up") ? result(false, "container assistant is unhealthy") : result(true),
    );

    const applied = await applyStack(
      { kind: "service", service: "assistant" },
      OPTIONS,
      deps(docker),
      { pull: "always" },
    );

    expect(applied.ok).toBe(false);
    expect(applied.error).toBeTruthy();
    expect(docker.calls[0]).toContain("pull");
    expect(docker.calls[1]).toContain("up");
  });

  test("does not accept a running container whose healthcheck is still starting", async () => {
    const docker = new FakeDocker((args) => {
      if (args.includes("up")) return result(false, "wait timeout");
      if (args.includes("ps")) {
        return {
          ok: true,
          stdout: JSON.stringify({ Service: "assistant", State: "running", Health: "starting" }),
          stderr: "",
          code: 0,
        };
      }
      return result(true);
    });

    const applied = await applyStack(
      { kind: "service", service: "assistant" },
      OPTIONS,
      deps(docker),
      { pull: "always" },
    );

    expect(applied.ok).toBe(false);
    expect(applied.started).toEqual([]);
    expect(applied.failed).toEqual([
      { service: "assistant", reason: "container assistant did not become healthy (state: running)" },
    ]);
    expect(applied.upFailed).toBe(true);
  });
});
