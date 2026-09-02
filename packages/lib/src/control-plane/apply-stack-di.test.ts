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
    expect(docker.calls[2]).toEqual(expect.arrayContaining(["config", "--services"]));
  });

  // #668: a container Compose calls an "orphan" is only "not in the
  // resolved profile set" — equally true of a service running because
  // OP_ENABLED_ADDONS drifted stale, or one started by hand. `--remove-orphans`
  // must never be part of the automatic full-stack apply; removing a
  // disabled addon's containers is a deliberate, manual step (compose
  // runbook), not something `update`/`install` does on the operator's behalf.
  test("never passes --remove-orphans, even for the full-stack scope", async () => {
    const docker = new FakeDocker();

    await applyStack({ kind: "all" }, OPTIONS, deps(docker), { pull: "always" });

    for (const call of docker.calls) {
      expect(call).not.toContain("--remove-orphans");
    }
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
    // The templated ps-state reason is kept, with the real `up` stderr
    // (#644) appended — "wait timeout" here is the whole of what compose
    // said, so it rides along even though it is not itself very specific.
    expect(applied.failed).toEqual([
      {
        service: "assistant",
        reason: "container assistant did not become healthy (state: running): wait timeout",
      },
    ]);
    expect(applied.upFailed).toBe(true);
  });

  // Regression (#644): a reapply that fails with `ps -a` still finding a row
  // (e.g. a `created`-but-not-started container after a failed recreate) used
  // to report ONLY the templated ps-state sentence — the real Docker daemon
  // error in `up`'s stderr was computed (`upResult.stderr`) but never reached
  // the caller. `rawStderr` carried it, but `error`/`failed[].reason` — what
  // lifecycle.ts's reapply path and every other `.error`-only caller actually
  // read — did not. Compose's own progress noise (including the `Recreate`
  // status line compose-errors.ts previously failed to filter, see its own
  // regression test) sits between the "up" call and the daemon error line, so
  // this also exercises that the real fix (summarizeComposeStderr) is used
  // here, not just "stderr is non-empty".
  test("folds the real daemon error into a per-service reason when ps -a still finds a row", async () => {
    const daemonError =
      "Error response from daemon: failed to set up container networking: driver failed " +
      "programming external connectivity on endpoint proj-assistant-1: failed to bind host " +
      "port 127.0.0.1:3810/tcp: address already in use";
    const upStderr = [
      " Container proj-assistant-1 Recreate ",
      " Container proj-assistant-1 Recreated ",
      " Container proj-assistant-1 Starting ",
      daemonError,
    ].join("\n");
    const docker = new FakeDocker((args) => {
      if (args.includes("up")) return result(false, upStderr);
      if (args.includes("ps")) {
        return {
          ok: true,
          stdout: JSON.stringify({ Service: "assistant", State: "created", Health: "" }),
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
    expect(applied.failed).toHaveLength(1);
    // The real cause must reach the operator — here classified, since the
    // daemon line is a port conflict, as the actionable port_in_use message
    // naming the port the daemon reported...
    expect(applied.failed[0]?.reason).toContain("Port 3810 is already in use");
    expect(applied.error).toContain("Port 3810 is already in use");
    // ...and the progress-only status line must NOT be what stands in for it.
    expect(applied.failed[0]?.reason).not.toBe("Container proj-assistant-1 Recreate");
    expect(applied.error).not.toBe("Container proj-assistant-1 Recreate");
  });

  // #676: a guardian whose readiness gate went unhealthy blocked Compose from
  // ever CREATING discord (its `depends_on: condition: service_healthy`), so
  // discord has no row at all in `ps -a`. The operator saw only "container
  // for service discord not found after up" — true, but useless, since the
  // real cause is guardian, a service they were not even trying to touch.
  describe("#676: names the unhealthy dependency behind a missing container", () => {
    test("missing target with an unhealthy dependency names it and includes the inspect output", async () => {
      const docker = new FakeDocker((args) => {
        if (args.includes("up")) return result(false, "");
        if (args.includes("ps")) {
          return {
            ok: true,
            stdout: JSON.stringify({ Service: "guardian", State: "running", Health: "unhealthy", ID: "abc123" }),
            stderr: "",
            code: 0,
          };
        }
        if (args.includes("inspect")) {
          return {
            ok: true,
            stdout: JSON.stringify({
              Log: [{ Output: '{"ok":false,"ready":false,"reason":"opencode proxy disabled"}', ExitCode: 1 }],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (args.includes("config")) {
          return {
            ok: true,
            stdout: JSON.stringify({ services: { discord: { depends_on: { guardian: { condition: "service_healthy" } } } } }),
            stderr: "",
            code: 0,
          };
        }
        return result(true);
      });

      const applied = await applyStack(
        { kind: "service", service: "discord" },
        OPTIONS,
        deps(docker),
        { pull: "always" },
      );

      expect(applied.ok).toBe(false);
      expect(applied.failed).toHaveLength(1);
      expect(applied.failed[0]?.reason).toContain("container for service discord not found after up");
      expect(applied.failed[0]?.reason).toContain("guardian");
      expect(applied.failed[0]?.reason).toContain("opencode proxy disabled");
    });

    test("an unhealthy target's own reason includes its last healthcheck output", async () => {
      const docker = new FakeDocker((args) => {
        if (args.includes("up")) return result(false, "");
        if (args.includes("ps")) {
          return {
            ok: true,
            stdout: JSON.stringify({ Service: "guardian", State: "running", Health: "unhealthy", ID: "abc123" }),
            stderr: "",
            code: 0,
          };
        }
        if (args.includes("inspect")) {
          return {
            ok: true,
            stdout: JSON.stringify({
              Log: [{ Output: '{"ok":false,"ready":false,"reason":"opencode proxy disabled"}', ExitCode: 1 }],
            }),
            stderr: "",
            code: 0,
          };
        }
        return result(true);
      });

      const applied = await applyStack(
        { kind: "service", service: "guardian" },
        OPTIONS,
        deps(docker),
        { pull: "always" },
      );

      expect(applied.ok).toBe(false);
      expect(applied.failed).toHaveLength(1);
      expect(applied.failed[0]?.reason).toContain("opencode proxy disabled");
    });

    test("falls back to today's wording when the inspect call fails", async () => {
      const docker = new FakeDocker((args) => {
        if (args.includes("up")) return result(false, "");
        if (args.includes("ps")) {
          return {
            ok: true,
            stdout: JSON.stringify({ Service: "guardian", State: "running", Health: "unhealthy", ID: "abc123" }),
            stderr: "",
            code: 0,
          };
        }
        if (args.includes("inspect")) return result(false, "Error: No such container: abc123");
        if (args.includes("config")) {
          return {
            ok: true,
            stdout: JSON.stringify({ services: { discord: { depends_on: { guardian: { condition: "service_healthy" } } } } }),
            stderr: "",
            code: 0,
          };
        }
        return result(true);
      });

      const applied = await applyStack(
        { kind: "service", service: "discord" },
        OPTIONS,
        deps(docker),
        { pull: "always" },
      );

      expect(applied.ok).toBe(false);
      expect(applied.failed).toEqual([
        { service: "discord", reason: "container for service discord not found after up" },
      ]);
    });

    test("resolves depends_on given in the shorthand array form", async () => {
      const docker = new FakeDocker((args) => {
        if (args.includes("up")) return result(false, "");
        if (args.includes("ps")) {
          return {
            ok: true,
            stdout: JSON.stringify({ Service: "guardian", State: "running", Health: "unhealthy", ID: "abc123" }),
            stderr: "",
            code: 0,
          };
        }
        if (args.includes("inspect")) {
          return {
            ok: true,
            stdout: JSON.stringify({ Log: [{ Output: '{"ok":false,"ready":false}', ExitCode: 1 }] }),
            stderr: "",
            code: 0,
          };
        }
        if (args.includes("config")) {
          return {
            ok: true,
            stdout: JSON.stringify({ services: { discord: { depends_on: ["guardian"] } } }),
            stderr: "",
            code: 0,
          };
        }
        return result(true);
      });

      const applied = await applyStack(
        { kind: "service", service: "discord" },
        OPTIONS,
        deps(docker),
        { pull: "always" },
      );

      expect(applied.ok).toBe(false);
      expect(applied.failed[0]?.reason).toContain("guardian");
      expect(applied.failed[0]?.reason).toContain('"ok":false');
    });
  });
});
