import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendBoundedStderr,
  buildComposePreflightError,
  checkDocker,
  composeConfigJson,
  COMPOSE_STREAM_STDERR_BUFFER_BYTES,
  detectExistingProject,
  dockerBin,
  ensureDockerReady,
  isComposePsRowHealthy,
  isProjectOurs,
  meetsComposeWaitFloor,
  parseComposePsRows,
  resolveComposeProjectName,
  runComposeStreaming,
  toDockerResult,
} from "./docker.js";

describe("isProjectOurs (ours-vs-foreign decision)", () => {
  it("treats a matching working_dir as ours", () => {
    expect(isProjectOurs("/home/me/.openpalm", "/home/me/.openpalm")).toBe(true);
  });

  it("treats a different working_dir as foreign", () => {
    expect(isProjectOurs("/home/other/.openpalm", "/home/me/.openpalm")).toBe(false);
  });

  it("does not authorize an empty or unknown working_dir", () => {
    expect(isProjectOurs("", "/home/me/.openpalm")).toBe(false);
    expect(isProjectOurs("   ", "/home/me/.openpalm")).toBe(false);
  });

  it("ignores surrounding whitespace on the label", () => {
    expect(isProjectOurs("  /home/me/.openpalm \n", "/home/me/.openpalm")).toBe(true);
  });
});

describe("detectExistingProject", () => {
  // Use a project name that cannot possibly match any running container so the
  // result is deterministic whether or not a docker daemon is present:
  //  - docker error (no daemon)      → { exists:false }
  //  - docker ok, no matching label  → { exists:false }
  const ghostName = `openpalm-detect-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it("returns exists:false when no project matches (or docker is unavailable)", async () => {
    const result = await detectExistingProject({
      projectName: ghostName,
      expectedWorkingDir: "/nonexistent/op_home",
    });
    expect(result.exists).toBe(false);
    expect(result.isOurs).toBe(false);
    expect(result.workingDir).toBe("");
  });
});

/**
 * D4: `docker ps -a` is newest-first, so inspecting only the first returned id
 * would let whichever container happens to be newest decide ours-vs-foreign
 * for the WHOLE project — unreliable in exactly the mixed case `-a` was added
 * to catch (our own containers alongside one foreign leftover). A fake
 * `docker` binary (OP_DOCKER_BIN, same knob dockerBin() reads) stands in for
 * the daemon so this is deterministic without one.
 */
describe("detectExistingProject (inspects EVERY matched container, not just ids[0])", () => {
  let scriptDir: string;
  const saved: Record<string, string | undefined> = {};

  function writeFakeDockerBin(): string {
    const scriptPath = join(scriptDir, "fake-docker.sh");
    writeFileSync(
      scriptPath,
      [
        "#!/bin/sh",
        'if [ "$1" = "ps" ]; then',
        "  for entry in $FAKE_PS_ROWS; do",
        '    id="${entry%%:*}"',
        '    state="${entry#*:}"',
        '    printf "%s\\t%s\\n" "$id" "$state"',
        "  done",
        "  exit 0",
        "fi",
        'if [ "$1" = "inspect" ]; then',
        "  shift 3", // drop "inspect" "--format" "<fmt>"
        '  for id in "$@"; do',
        "    case \"$id\" in",
        "      *foreign*) echo \"$FAKE_FOREIGN_DIR\" ;;",
        "      *) echo \"$FAKE_OURS_DIR\" ;;",
        "    esac",
        "  done",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  beforeEach(() => {
    scriptDir = mkdtempSync(join(tmpdir(), "openpalm-fake-docker-"));
    for (const key of ["OP_DOCKER_BIN", "FAKE_PS_ROWS", "FAKE_OURS_DIR", "FAKE_FOREIGN_DIR"]) {
      saved[key] = process.env[key];
    }
    process.env.OP_DOCKER_BIN = writeFakeDockerBin();
    process.env.FAKE_OURS_DIR = "/home/me/.openpalm";
    process.env.FAKE_FOREIGN_DIR = "/home/other/.openpalm";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scriptDir, { recursive: true, force: true });
  });

  it("is NOT ours when a foreign container sorts first (newest) but an ours container also matches", async () => {
    process.env.FAKE_PS_ROWS = "container-foreign-1:exited container-ours-2:running";

    const result = await detectExistingProject({
      projectName: "openpalm",
      expectedWorkingDir: process.env.FAKE_OURS_DIR ?? "",
    });

    expect(result.exists).toBe(true);
    expect(result.isOurs).toBe(false);
    // Names the actual foreign conflict, not whichever id happened to be first.
    expect(result.workingDir).toBe(process.env.FAKE_FOREIGN_DIR);
  });

  it("is ours only when EVERY matched container's working_dir matches, regardless of order", async () => {
    process.env.FAKE_PS_ROWS = "container-ours-2:running container-ours-1:exited";

    const result = await detectExistingProject({
      projectName: "openpalm",
      expectedWorkingDir: process.env.FAKE_OURS_DIR ?? "",
    });

    expect(result.exists).toBe(true);
    expect(result.isOurs).toBe(true);
    expect(result.workingDir).toBe(process.env.FAKE_OURS_DIR);
  });

  it("reports running:true when at least one matched container is running", async () => {
    process.env.FAKE_PS_ROWS = "container-ours-1:exited container-ours-2:running";

    const result = await detectExistingProject({
      projectName: "openpalm",
      expectedWorkingDir: process.env.FAKE_OURS_DIR ?? "",
    });

    expect(result.running).toBe(true);
  });

  it("reports running:false when every matched container is stopped", async () => {
    process.env.FAKE_PS_ROWS = "container-ours-1:exited container-ours-2:created";

    const result = await detectExistingProject({
      projectName: "openpalm",
      expectedWorkingDir: process.env.FAKE_OURS_DIR ?? "",
    });

    expect(result.running).toBe(false);
  });
});

// ── §655.2: runComposeStreaming's stderr tee + bounded classification ─────

describe("appendBoundedStderr (§655.2 ring buffer)", () => {
  it("passes short input through unchanged", () => {
    expect(appendBoundedStderr("", "hello", 1024)).toBe("hello");
    expect(appendBoundedStderr("hello ", "world", 1024)).toBe("hello world");
  });

  it("keeps only the last maxBytes bytes, dropping the oldest content", () => {
    const result = appendBoundedStderr("a".repeat(10), "b".repeat(10), 12);
    expect(result.length).toBe(12);
    // The tail survives; the earlier "a"s are dropped.
    expect(result).toBe("a".repeat(2) + "b".repeat(10));
  });

  it("bounds by UTF-8 BYTE length, not JS string length", () => {
    // "é" is 1 JS string char but 2 UTF-8 bytes — a char-length bound would
    // let this through; a byte-length bound must not.
    const result = appendBoundedStderr("", "é".repeat(10), 10);
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(10);
  });

  it("never exceeds maxBytes across repeated appends", () => {
    let buf = "";
    for (let i = 0; i < 50; i++) {
      buf = appendBoundedStderr(buf, `line ${i}\n`, 200);
    }
    expect(Buffer.byteLength(buf, "utf-8")).toBeLessThanOrEqual(200);
    // The most recent content survives.
    expect(buf).toContain("line 49");
  });
});

describe("runComposeStreaming (§655.2 stderr tee + mapDockerError classification)", () => {
  const saved: Record<string, string | undefined> = {};
  let scriptDir: string;

  function writeFakeDockerBin(script: string): string {
    const scriptPath = join(scriptDir, "fake-docker-streaming.sh");
    writeFileSync(scriptPath, script);
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  beforeEach(() => {
    scriptDir = mkdtempSync(join(tmpdir(), "openpalm-fake-docker-streaming-"));
    saved.OP_DOCKER_BIN = process.env.OP_DOCKER_BIN;
  });

  afterEach(() => {
    if (saved.OP_DOCKER_BIN === undefined) delete process.env.OP_DOCKER_BIN;
    else process.env.OP_DOCKER_BIN = saved.OP_DOCKER_BIN;
    rmSync(scriptDir, { recursive: true, force: true });
  });

  it("resolves on exit code 0 without touching stderr classification", async () => {
    process.env.OP_DOCKER_BIN = writeFakeDockerBin(
      ["#!/bin/sh", 'echo "Container demo-app-1 Started" >&2', "exit 0", ""].join("\n"),
    );
    await expect(runComposeStreaming(["up", "-d"])).resolves.toBeUndefined();
  });

  it("classifies a non-zero exit through mapDockerError instead of the old bare exit-code message", async () => {
    // Same fixture wording the existing compose-errors "maps port conflicts"
    // test uses, so this proves runComposeStreaming's rejection now goes
    // through the SAME classification applyStack uses — not the previous
    // bare `docker compose <args> failed with exit code N`, which carried
    // nothing mapDockerError could work with.
    process.env.OP_DOCKER_BIN = writeFakeDockerBin(
      [
        "#!/bin/sh",
        'echo "Container demo-app-1 Recreate" >&2',
        'echo "Container demo-app-1 Recreated" >&2',
        'echo "Container demo-app-1 Starting" >&2',
        'echo "Error response from daemon: Ports are not available: exposing port TCP 0.0.0.0:3880 -> 0.0.0.0:0: listen tcp 0.0.0.0:3880: bind: address already in use" >&2',
        "exit 1",
        "",
      ].join("\n"),
    );
    await expect(runComposeStreaming(["up", "-d"])).rejects.toThrow(
      "Port 3880 is already in use by another program. Free it, then retry.",
    );
  });

  it("still rejects with the raw spawn error when the binary itself cannot be found (unchanged)", async () => {
    process.env.OP_DOCKER_BIN = join(scriptDir, "does-not-exist");
    await expect(runComposeStreaming(["up", "-d"])).rejects.toThrow(/ENOENT/);
  });

  it("keeps the SIGTERM timeout behavior on a run that exceeds its budget", async () => {
    // No trap: an untrapped SIGTERM's default disposition (terminate) fires
    // immediately even while the shell is blocked on the foreground `sleep`
    // — a trap handler would instead only run once the shell regains control
    // (i.e. after `sleep` itself returns), which defeats the whole point of
    // the timeout.
    process.env.OP_DOCKER_BIN = writeFakeDockerBin(["#!/bin/sh", "sleep 30", ""].join("\n"));
    await expect(runComposeStreaming(["up", "-d"], { timeoutMs: 200 })).rejects.toThrow();
  }, 5000);

  it("classifies the real daemon error even when preceded by far more than the 64 KiB buffer bound", async () => {
    // Proves the bound is respected end-to-end, not just in the pure
    // appendBoundedStderr unit tests above: ~200 KiB of progress noise (well
    // over COMPOSE_STREAM_STDERR_BUFFER_BYTES) is written first, so if the
    // buffer were unbounded OR mis-truncated, the real error at the tail
    // could be pushed out or corrupted. It survives either way.
    const paddingLines = Array.from(
      { length: 4000 },
      (_, i) => `echo "Container demo-app-1 Waiting ${"x".repeat(40)} ${i}" >&2`,
    ).join("\n");
    expect(paddingLines.length).toBeGreaterThan(COMPOSE_STREAM_STDERR_BUFFER_BYTES);
    process.env.OP_DOCKER_BIN = writeFakeDockerBin(
      [
        "#!/bin/sh",
        paddingLines,
        'echo "Error response from daemon: toomanyrequests: You have reached your pull rate limit." >&2',
        "exit 1",
        "",
      ].join("\n"),
    );
    await expect(runComposeStreaming(["up", "-d"])).rejects.toThrow(/pull rate limit/);
  });
});

describe("resolveComposeProjectName", () => {
  const saved = process.env.OP_PROJECT_NAME;
  afterEach(() => {
    if (saved === undefined) delete process.env.OP_PROJECT_NAME;
    else process.env.OP_PROJECT_NAME = saved;
  });

  it("defaults to openpalm", () => {
    delete process.env.OP_PROJECT_NAME;
    delete process.env.COMPOSE_PROJECT_NAME;
    expect(resolveComposeProjectName({})).toBe("openpalm");
  });

  it("honors OP_PROJECT_NAME from overrides first", () => {
    expect(resolveComposeProjectName({ OP_PROJECT_NAME: "openpalm-dev" })).toBe("openpalm-dev");
  });
});

describe("buildComposePreflightError (shared CLI + lib message)", () => {
  const savedProject = process.env.OP_PROJECT_NAME;
  const savedCompose = process.env.COMPOSE_PROJECT_NAME;
  beforeEach(() => {
    // Force the default project name so assertions are ambient-env independent.
    delete process.env.OP_PROJECT_NAME;
    delete process.env.COMPOSE_PROJECT_NAME;
  });
  afterEach(() => {
    if (savedProject === undefined) delete process.env.OP_PROJECT_NAME;
    else process.env.OP_PROJECT_NAME = savedProject;
    if (savedCompose === undefined) delete process.env.COMPOSE_PROJECT_NAME;
    else process.env.COMPOSE_PROJECT_NAME = savedCompose;
  });

  const options = {
    files: ["/home/base.yml", "/home/addon.yml"],
    envFiles: ["/home/stack.env"],
    profiles: ["addon.voice.cpu", "addon.ollama.cpu"],
  };

  it("includes the raw stderr, resolved command, and file/env/project breakdown", () => {
    const msg = buildComposePreflightError(options, "boom: bad substitution");
    expect(msg).toContain("Compose preflight failed: boom: bad substitution");
    expect(msg).toContain("Resolved command: docker compose");
    expect(msg).toContain("-f /home/base.yml -f /home/addon.yml");
    expect(msg).toContain("--project-name openpalm");
    expect(msg).toContain("--env-file /home/stack.env");
    expect(msg).toContain("config --quiet");
    expect(msg).toContain("Files: /home/base.yml, /home/addon.yml");
    // The Env files: breakdown line lists only files that exist on disk; the
    // fictitious /home/stack.env is filtered out there (it still appears in the
    // resolved command above for reproducibility).
    const envLine = msg.split("\n").find((l) => l.startsWith("Env files:"));
    expect(envLine).toBe("Env files: ");
    expect(msg).toContain("Project: openpalm");
  });

  it("carries the profile args in the resolved command (lib-side info preserved)", () => {
    const msg = buildComposePreflightError(options, "boom");
    expect(msg).toContain("--profile addon.voice.cpu --profile addon.ollama.cpu");
  });

  it("appends missing-secret repair guidance when the failure looks like a missing file", () => {
    const msg = buildComposePreflightError(
      options,
      'env file /home/secrets/openai.secret: no such file or directory',
    );
    expect(msg).toContain("your OpenPalm home is missing files");
    expect(msg).toContain("Run `openpalm update` to repair it");
  });

  it("keeps BOTH the missing-secret guidance AND the profile args together", () => {
    const msg = buildComposePreflightError(
      options,
      'secret "openai_api_key" not found',
    );
    expect(msg).toContain("--profile addon.voice.cpu");
    expect(msg).toContain("your OpenPalm home is missing files");
  });

  it("names a remedy that actually exists for a missing op_ui_login_password secret", () => {
    // K5 residual: no ensure path (including `openpalm update`) mints this
    // secret — only setup or `openpalm reset-password` do — so the generic
    // "run update to repair it" guidance would send the operator in a circle.
    const msg = buildComposePreflightError(
      options,
      'secret "ui_login_password" not found: /home/.openpalm/state/secrets/op_ui_login_password: no such file or directory',
    );
    expect(msg).toContain("openpalm reset-password");
    expect(msg).not.toContain("Run `openpalm update` to repair it");
  });

  it("omits guidance for a generic (non-missing-file) failure", () => {
    const msg = buildComposePreflightError(options, "yaml: mapping values are not allowed");
    expect(msg).not.toContain("your OpenPalm home is missing files");
  });

  it("omits an empty profile slot when there are no profiles", () => {
    const msg = buildComposePreflightError(
      { files: ["/home/base.yml"], envFiles: [] },
      "boom",
    );
    expect(msg).not.toContain("--profile");
    expect(msg).not.toContain("--env-file");
    // No double spaces from empty arg slots.
    expect(msg).not.toContain("  ");
  });
});

describe("composeConfigJson (async variant of composeConfigJsonSync — same error semantics)", () => {
  let scriptDir: string;
  const saved: Record<string, string | undefined> = {};

  function writeFakeDockerBin(): string {
    // Same OP_DOCKER_BIN seam as the detectExistingProject suite above: a fake
    // engine driven by FAKE_MODE so no daemon is needed.
    const scriptPath = join(scriptDir, "fake-docker-config.sh");
    writeFileSync(
      scriptPath,
      [
        "#!/bin/sh",
        'if [ "$FAKE_MODE" = "ok" ]; then',
        "  printf '{\"services\":{\"assistant\":{}}}'",
        "  exit 0",
        "fi",
        'if [ "$FAKE_MODE" = "badjson" ]; then',
        "  printf 'not json'",
        "  exit 0",
        "fi",
        'echo "boom from fake docker" >&2',
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  beforeEach(() => {
    scriptDir = mkdtempSync(join(tmpdir(), "openpalm-fake-docker-config-"));
    for (const key of ["OP_DOCKER_BIN", "FAKE_MODE"]) saved[key] = process.env[key];
    process.env.OP_DOCKER_BIN = writeFakeDockerBin();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scriptDir, { recursive: true, force: true });
  });

  it("resolves ok:true with the parsed project on success", async () => {
    process.env.FAKE_MODE = "ok";
    const result = await composeConfigJson({ files: ["/nonexistent/compose.yml"] });
    expect(result.ok).toBe(true);
    expect(result.config).toEqual({ services: { assistant: {} } } as never);
    expect(result.stderr).toBe("");
  });

  it("resolves ok:false with stderr on a compose failure (never rejects)", async () => {
    process.env.FAKE_MODE = "fail";
    const result = await composeConfigJson({ files: ["/nonexistent/compose.yml"] });
    expect(result.ok).toBe(false);
    expect(result.config).toBeNull();
    expect(result.stderr).toContain("boom from fake docker");
  });

  it("resolves ok:false on unparsable JSON output", async () => {
    process.env.FAKE_MODE = "badjson";
    const result = await composeConfigJson({ files: ["/nonexistent/compose.yml"] });
    expect(result.ok).toBe(false);
    expect(result.config).toBeNull();
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe("toDockerResult (execFile error → DockerResult code normalization)", () => {
  it("does NOT store NaN when error.code is a STRING errno (ENOENT)", () => {
    // docker binary missing → node spawn error carries a string `code`.
    const err = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    const result = toDockerResult(err, "", "");
    // The regression: Number("ENOENT") → NaN silently stored in a number field.
    expect(Number.isNaN(result.code)).toBe(false);
    expect(typeof result.code).toBe("number");
    // Any error means the run failed and the numeric code must be non-zero.
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe(0);
    // The original string errno is preserved and accessible.
    expect(result.errorCode).toBe("ENOENT");
  });

  it("passes a numeric exit status through unchanged (no errorCode)", () => {
    const err = Object.assign(new Error("exited"), { code: 127 });
    const result = toDockerResult(err, "out", "boom");
    expect(result.code).toBe(127);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBeUndefined();
  });

  it("reports code 0 and ok on a clean run", () => {
    const result = toDockerResult(null, "hello", "");
    expect(result).toEqual({ ok: true, stdout: "hello", stderr: "", code: 0 });
  });
});

describe("meetsComposeWaitFloor (§2.1 precondition: Compose version floor for --wait)", () => {
  it("accepts a version at or above the v2.17.0 floor", () => {
    expect(meetsComposeWaitFloor("Docker Compose version v2.17.0")).toBe(true);
    expect(meetsComposeWaitFloor("Docker Compose version v2.29.1")).toBe(true);
    expect(meetsComposeWaitFloor("Docker Compose version v3.0.0")).toBe(true);
  });

  it("rejects a version below the floor", () => {
    expect(meetsComposeWaitFloor("Docker Compose version v2.16.9")).toBe(false);
    expect(meetsComposeWaitFloor("Docker Compose version v2.14.0")).toBe(false);
    expect(meetsComposeWaitFloor("Docker Compose version v2.0.0")).toBe(false);
    expect(meetsComposeWaitFloor("Docker Compose version v1.29.2")).toBe(false);
  });

  it("fails OPEN (treats as new enough) when the version string is unparsable", () => {
    expect(meetsComposeWaitFloor("")).toBe(true);
    expect(meetsComposeWaitFloor("some unexpected output")).toBe(true);
  });
});

describe("checkDocker (errorCode propagation, D1)", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it("propagates errorCode ENOENT when the docker binary cannot be found", async () => {
    process.env.PATH = "/nonexistent-bin-dir-for-check-docker-test";
    const result = await checkDocker();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("ENOENT");
  });
});

describe("dockerBin (F2)", () => {
  const saved = process.env.OP_DOCKER_BIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.OP_DOCKER_BIN;
    else process.env.OP_DOCKER_BIN = saved;
  });

  it("defaults to 'docker' when OP_DOCKER_BIN is unset", () => {
    delete process.env.OP_DOCKER_BIN;
    expect(dockerBin()).toBe("docker");
  });

  it("honors OP_DOCKER_BIN when set (e.g. to a podman shim)", () => {
    process.env.OP_DOCKER_BIN = "podman";
    expect(dockerBin()).toBe("podman");
  });

  it("trims whitespace and falls back to 'docker' for a blank override", () => {
    process.env.OP_DOCKER_BIN = "   ";
    expect(dockerBin()).toBe("docker");
    process.env.OP_DOCKER_BIN = "  /usr/local/bin/podman  ";
    expect(dockerBin()).toBe("/usr/local/bin/podman");
  });
});

describe("ensureDockerReady (D1)", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it("maps a missing docker binary to a non-blank, friendly not-installed message", async () => {
    // No directory on this PATH contains a `docker` executable, so the
    // underlying execFile spawn fails with ENOENT and empty stderr — this is
    // the "empty-stderr ENOENT case" ensureDockerReady must still map through
    // mapDockerError's friendly not-installed branch (D1), not surface blank.
    process.env.PATH = "/nonexistent-bin-dir-for-ensure-docker-ready-test";
    const result = await ensureDockerReady();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message.toLowerCase()).toContain("not installed");
    }
  });
});

describe("parseComposePsRows (`compose ps --format json` parser)", () => {
  it("parses one JSON object per line, keyed by the Service field", () => {
    const stdout = [
      JSON.stringify({ Service: "assistant", State: "running", Health: "" }),
      JSON.stringify({ Service: "guardian", State: "running", Health: "unhealthy" }),
    ].join("\n");
    expect(parseComposePsRows(stdout)).toEqual([
      { service: "assistant", state: "running", health: "", id: "", exitCode: null },
      { service: "guardian", state: "running", health: "unhealthy", id: "", exitCode: null },
    ]);
  });

  it("matches by the Service field, NEVER a container-name suffix like assistant-1", () => {
    const stdout = JSON.stringify({ Name: "openpalm-assistant-1", Service: "assistant", State: "running", Health: "" });
    const rows = parseComposePsRows(stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0].service).toBe("assistant");
  });

  it("returns an empty array for empty or unparsable input", () => {
    expect(parseComposePsRows("")).toEqual([]);
    expect(parseComposePsRows("not json\n\nalso not json")).toEqual([]);
  });

  it("handles a JSON array on a single line (some Compose versions emit this shape)", () => {
    const stdout = JSON.stringify([
      { Service: "assistant", State: "running", Health: "" },
      { Service: "guardian", State: "exited", Health: "" },
    ]);
    expect(parseComposePsRows(stdout)).toEqual([
      { service: "assistant", state: "running", health: "", id: "", exitCode: null },
      { service: "guardian", state: "exited", health: "", id: "", exitCode: null },
    ]);
  });

  it("captures ExitCode, so a completed one-shot can be told from a crash", () => {
    const stdout = [
      JSON.stringify({ Service: "paperclip-locale", State: "exited", Health: "", ExitCode: 0 }),
      JSON.stringify({ Service: "broken", State: "exited", Health: "", ExitCode: 1 }),
    ].join("\n");
    const rows = parseComposePsRows(stdout);
    expect(rows[0].exitCode).toBe(0);
    expect(rows[1].exitCode).toBe(1);
  });

  // The live bug: `compose ps` WITHOUT -a omits exited containers, so a one-shot
  // that had already done its job and exited 0 was reported as "container for
  // service X not found after up" — a failed deploy manufactured from a success,
  // which then rolled the stack back and pinned it to rollback- image tags.
  it("treats a one-shot that exited 0 as healthy, and a nonzero exit as not", () => {
    const ok = parseComposePsRows(
      JSON.stringify({ Service: "paperclip-locale", State: "exited", Health: "", ExitCode: 0 }),
    )[0];
    const bad = parseComposePsRows(
      JSON.stringify({ Service: "broken", State: "exited", Health: "", ExitCode: 1 }),
    )[0];
    expect(isComposePsRowHealthy(ok)).toBe(true);
    expect(isComposePsRowHealthy(bad)).toBe(false);
  });

  // D6: the interim deploy poll (deploy.ts's startInterimStatusPoll) tells a
  // freshly (re)created container apart from a stale one left over from a
  // PREVIOUS `up` by comparing container IDs, so the ID must survive parsing.
  it("captures the container ID (used to tell a fresh container from a stale one)", () => {
    const stdout = JSON.stringify({ ID: "abc123", Service: "assistant", State: "running", Health: "" });
    expect(parseComposePsRows(stdout)).toEqual([
      { service: "assistant", state: "running", health: "", id: "abc123", exitCode: null },
    ]);
  });
});
