import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stackEnvPath } from "./paths.js";
import {
  buildComposeCommandArgs,
  buildComposePreflightError,
  checkDocker,
  checkDockerCompose,
  inspectContainerImage,
} from "./docker.js";
import type { ControlPlaneState } from "./types.js";

// Regression locks for the DRY-onto-canonical-helpers refactor. These assert the
// equivalences that make the routing behavior-preserving: the canonical
// `stackEnvPath(state)` must reproduce the old inline `${stashDir}/env/stack.env`
// literal, `buildComposeCommandArgs` must reproduce the -f/--env-file/--profile
// arg-building rules (env files filtered by existsSync) that deploy.ts's
// deleted (§2.1) missingServiceImages helper used to hand-build,
// and the run()-routed docker probes keep their ok/stdout/stderr/code semantics.

describe("stackEnvPath is the canonical stashDir-based stack.env path", () => {
  it("equals the previously-inlined `${stashDir}/env/stack.env` literal", () => {
    const state = { stashDir: "/op/home/knowledge" } as ControlPlaneState;
    expect(stackEnvPath(state)).toBe(`${state.stashDir}/env/stack.env`);
    expect(stackEnvPath(state)).toBe("/op/home/knowledge/env/stack.env");
  });
});

describe("buildComposeCommandArgs reproduces the deleted missingServiceImages' hand-built args", () => {
  const savedProject = process.env.OP_PROJECT_NAME;
  const savedCompose = process.env.COMPOSE_PROJECT_NAME;
  let dir: string;
  beforeEach(() => {
    delete process.env.OP_PROJECT_NAME;
    delete process.env.COMPOSE_PROJECT_NAME;
    dir = mkdtempSync(join(tmpdir(), "route-args-"));
  });
  afterEach(() => {
    if (savedProject === undefined) delete process.env.OP_PROJECT_NAME;
    else process.env.OP_PROJECT_NAME = savedProject;
    if (savedCompose === undefined) delete process.env.COMPOSE_PROJECT_NAME;
    else process.env.COMPOSE_PROJECT_NAME = savedCompose;
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits the same -f/--env-file/--profile args (env files filtered by existsSync)", () => {
    // Mix an env file that exists with one that does not, so the existsSync
    // predicate actually discriminates — this locks the original
    // `.filter((file) => existsSync(file))` behavior rather than a weaker
    // `length > 0` stand-in.
    const presentEnv = join(dir, "stack.env");
    writeFileSync(presentEnv, "OP_X=1\n");
    const absentEnv = join(dir, "does-not-exist.env");

    const composeOpts = {
      files: ["/x/core.compose.yml", "/x/services.compose.yml"],
      envFiles: [presentEnv, absentEnv],
      profiles: ["addon.voice.cpu", "addon.ollama.cpu"],
    };

    // The exact -f/--env-file/--profile portion the old hand-built array
    // produced (deploy.ts's now-deleted missingServiceImages, §2.1), using the
    // ORIGINAL existsSync env-file predicate.
    const handBuiltCore = [
      ...composeOpts.files.flatMap((file) => ["-f", file]),
      ...composeOpts.envFiles.filter((file) => existsSync(file)).flatMap((file) => ["--env-file", file]),
      ...composeOpts.profiles.flatMap((profile) => ["--profile", profile]),
    ];

    const helper = buildComposeCommandArgs(composeOpts);
    expect(helper.slice(0, 2)).toEqual(["--project-name", "openpalm"]);
    expect(helper.slice(2)).toEqual(handBuiltCore);
    // The absent env file must have been dropped.
    expect(helper).not.toContain(absentEnv);
    expect(helper).toContain(presentEnv);
  });
});

describe("buildComposePreflightError preserves the reconcileCore message content", () => {
  const savedProject = process.env.OP_PROJECT_NAME;
  const savedCompose = process.env.COMPOSE_PROJECT_NAME;
  let dir: string;
  beforeEach(() => {
    delete process.env.OP_PROJECT_NAME;
    delete process.env.COMPOSE_PROJECT_NAME;
    dir = mkdtempSync(join(tmpdir(), "route-preflight-"));
  });
  afterEach(() => {
    if (savedProject === undefined) delete process.env.OP_PROJECT_NAME;
    else process.env.OP_PROJECT_NAME = savedProject;
    if (savedCompose === undefined) delete process.env.COMPOSE_PROJECT_NAME;
    else process.env.COMPOSE_PROJECT_NAME = savedCompose;
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps Files/Env files (existsSync-filtered)/Profiles/Project lines", () => {
    const presentEnv = join(dir, "stack.env");
    writeFileSync(presentEnv, "OP_X=1\n");
    const absentEnv = join(dir, "missing.env");
    const msg = buildComposePreflightError(
      {
        files: ["/x/core.compose.yml"],
        envFiles: [presentEnv, absentEnv],
        profiles: ["addon.voice.cpu"],
      },
      "boom",
    );
    expect(msg).toContain("Compose preflight failed: boom");
    expect(msg).toContain("Files: /x/core.compose.yml");
    // The Env files: breakdown line lists only the file that exists (existsSync
    // filter); the absent file is dropped there even though the resolved-command
    // line above lists all env files verbatim for reproducibility.
    const envLine = msg.split("\n").find((l) => l.startsWith("Env files:"));
    expect(envLine).toBe(`Env files: ${presentEnv}`);
    // Profiles line is present (no content lost when routing reconcileCore here).
    expect(msg).toContain("Profiles: addon.voice.cpu");
    expect(msg).toContain("Project: openpalm");
  });

  it("renders Profiles: (none) when no profiles are active", () => {
    const msg = buildComposePreflightError({ files: ["/x/core.compose.yml"], envFiles: [], profiles: [] }, "boom");
    expect(msg).toContain("Profiles: (none)");
  });
});

// ── run()-routing coverage for the docker probes ────────────────────────────
// checkDocker / checkDockerCompose / inspectContainerImage were rerouted through
// the shared run() execFile wrapper. Exercise each end-to-end against a fake
// `docker` binary injected onto PATH so the ok/stdout/stderr/code semantics are
// locked without a real daemon.

describe("run()-routed docker probes (fake docker on PATH)", () => {
  let binDir: string;
  const savedPath = process.env.PATH;
  const fakeEnvKeys = ["FAKE_INFO_STDOUT", "FAKE_INFO_EXIT", "FAKE_INSPECT_NOTFOUND"] as const;
  const savedFakeEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "fake-docker-"));
    const script = [
      "#!/bin/sh",
      'case "$1" in',
      "  info)",
      "    printf '%s' \"$FAKE_INFO_STDOUT\"",
      "    exit ${FAKE_INFO_EXIT:-0}",
      "    ;;",
      "  compose)",
      "    printf 'Docker Compose version v2.20.0\\n'",
      "    exit 0",
      "    ;;",
      "  inspect)",
      '    if [ "$FAKE_INSPECT_NOTFOUND" = "1" ]; then',
      "      printf 'Error: No such object' 1>&2",
      "      exit 1",
      "    fi",
      "    printf 'running\\tsha256:abc\\topenpalm/assistant:latest\\thealthy'",
      "    exit 0",
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n");
    const dockerBin = join(binDir, "docker");
    writeFileSync(dockerBin, script);
    chmodSync(dockerBin, 0o755);
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    for (const k of fakeEnvKeys) savedFakeEnv[k] = process.env[k];
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    for (const k of fakeEnvKeys) {
      if (savedFakeEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedFakeEnv[k];
    }
    rmSync(binDir, { recursive: true, force: true });
  });

  it("checkDocker: available when stdout has a version (exit 0)", async () => {
    process.env.FAKE_INFO_STDOUT = "24.0.5";
    process.env.FAKE_INFO_EXIT = "0";
    const r = await checkDocker();
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("24.0.5");
  });

  it("checkDocker: available even when exit is non-zero but stdout has a version", async () => {
    // docker info can exit non-zero on warnings (e.g. no swap limit) while still
    // reporting a version — treated as available.
    process.env.FAKE_INFO_STDOUT = "24.0.5";
    process.env.FAKE_INFO_EXIT = "1";
    const r = await checkDocker();
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("24.0.5");
  });

  it("checkDocker: unavailable when no stdout and non-zero exit", async () => {
    process.env.FAKE_INFO_STDOUT = "";
    process.env.FAKE_INFO_EXIT = "1";
    const r = await checkDocker();
    expect(r.ok).toBe(false);
    expect(r.stdout).toBe("");
    expect(r.code).toBe(1);
  });

  it("checkDockerCompose: passes through run() ok/stdout", async () => {
    const r = await checkDockerCompose();
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("Docker Compose version");
  });

  it("inspectContainerImage: parses tab-separated inspect output", async () => {
    delete process.env.FAKE_INSPECT_NOTFOUND;
    const info = await inspectContainerImage("some-container");
    expect(info).toEqual({
      digest: "sha256:abc",
      tag: "openpalm/assistant:latest",
      healthStatus: "healthy",
      state: "running",
    });
  });

  it("inspectContainerImage: not_installed when inspect fails (no such object)", async () => {
    process.env.FAKE_INSPECT_NOTFOUND = "1";
    const info = await inspectContainerImage("ghost-container");
    expect(info).toEqual({ digest: "", tag: "", healthStatus: "", state: "not_installed" });
  });
});
