/**
 * #650: openpalm.sh/.ps1 are RENDERED (see openpalm-helper-script.ts) rather
 * than a hand-maintained shell reimplementation of the overlay/project-name
 * resolution. These tests cover: the render bakes exactly what
 * discoverStackOverlays/resolveComposeProjectName resolve; the rendered
 * script is valid bash; and both refusal guards (OP_HOME mismatch, empty
 * project name) actually fire when the real script is run with bash.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenpalmPowerShellHelper,
  buildOpenpalmShellHelper,
  OPENPALM_PS1_FILENAME,
  OPENPALM_SH_FILENAME,
  renderOpenpalmHelperScripts,
  type OpenpalmHelperScriptInputs,
} from "./openpalm-helper-script.js";
import { discoverStackOverlays } from "./config-persistence.js";
import { resolveComposeProjectName } from "./docker.js";

const SAMPLE_INPUTS: OpenpalmHelperScriptInputs = {
  renderedOpHome: "/home/me/.openpalm",
  projectName: "openpalm",
  relativeFiles: [
    "system/stack/core.compose.yml",
    "system/stack/services.compose.yml",
    "system/stack/portals.compose.yml",
    "config/stack/custom.compose.yml",
  ],
};

describe("buildOpenpalmShellHelper (pure render)", () => {
  it("bakes the resolved OP_HOME, project name, and file list", () => {
    const script = buildOpenpalmShellHelper(SAMPLE_INPUTS);
    expect(script).toContain('RENDERED_OP_HOME="/home/me/.openpalm"');
    expect(script).toContain('RENDERED_PROJECT_NAME="openpalm"');
    for (const f of SAMPLE_INPUTS.relativeFiles) {
      expect(script).toContain(`"${f}"`);
    }
  });

  it("is syntactically valid bash", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-sh-syntax-"));
    try {
      const scriptPath = join(dir, "openpalm.sh");
      writeFileSync(scriptPath, buildOpenpalmShellHelper(SAMPLE_INPUTS));
      const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf-8" });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run when the live OP_HOME differs from the one it was rendered for", () => {
    const renderedHomeDir = mkdtempSync(join(tmpdir(), "openpalm-sh-rendered-home-"));
    const otherHomeDir = mkdtempSync(join(tmpdir(), "openpalm-sh-other-home-"));
    try {
      const inputs: OpenpalmHelperScriptInputs = { ...SAMPLE_INPUTS, renderedOpHome: renderedHomeDir };
      const scriptPath = join(otherHomeDir, OPENPALM_SH_FILENAME);
      writeFileSync(scriptPath, buildOpenpalmShellHelper(inputs));
      chmodSync(scriptPath, 0o755);

      // OP_HOME set explicitly (not left to the script's cwd/SCRIPT_DIR
      // default) so this test is deterministic regardless of the ambient
      // throwaway OP_HOME the repo's bunfig.toml preload sets for every
      // `bun test` run (scripts/test-isolate-op-home.ts).
      const result = spawnSync("bash", [scriptPath, "up"], {
        cwd: otherHomeDir,
        encoding: "utf-8",
        env: { ...process.env, OP_HOME: otherHomeDir },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("rendered for OP_HOME=");
      expect(result.stderr).toContain(renderedHomeDir);
      expect(result.stderr).toContain(otherHomeDir);
    } finally {
      rmSync(renderedHomeDir, { recursive: true, force: true });
      rmSync(otherHomeDir, { recursive: true, force: true });
    }
  });

  it("refuses to run when the baked project name is empty", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openpalm-sh-empty-project-"));
    try {
      const inputs: OpenpalmHelperScriptInputs = {
        ...SAMPLE_INPUTS,
        renderedOpHome: homeDir,
        projectName: "",
      };
      const scriptPath = join(homeDir, OPENPALM_SH_FILENAME);
      writeFileSync(scriptPath, buildOpenpalmShellHelper(inputs));
      chmodSync(scriptPath, 0o755);

      const result = spawnSync("bash", [scriptPath, "up"], {
        cwd: homeDir,
        encoding: "utf-8",
        env: { ...process.env, OP_HOME: homeDir, OP_PROJECT_NAME: "", COMPOSE_PROJECT_NAME: "" },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no Compose project name was recorded");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("refuses to run when the first overlay file is missing (stale render)", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openpalm-sh-stale-render-"));
    try {
      const inputs: OpenpalmHelperScriptInputs = { ...SAMPLE_INPUTS, renderedOpHome: homeDir };
      const scriptPath = join(homeDir, OPENPALM_SH_FILENAME);
      writeFileSync(scriptPath, buildOpenpalmShellHelper(inputs));
      chmodSync(scriptPath, 0o755);
      // No system/stack/core.compose.yml written under homeDir — the render
      // is stale for what's actually on disk.

      const result = spawnSync("bash", [scriptPath, "up"], {
        cwd: homeDir,
        encoding: "utf-8",
        env: { ...process.env, OP_HOME: homeDir },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not found");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reaches the docker invocation (does not refuse) when OP_HOME, project, and files all check out", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openpalm-sh-happy-path-"));
    const fakeBinDir = mkdtempSync(join(tmpdir(), "openpalm-sh-fake-docker-"));
    try {
      mkdirSync(join(homeDir, "system", "stack"), { recursive: true });
      mkdirSync(join(homeDir, "config", "stack"), { recursive: true });
      writeFileSync(join(homeDir, "system", "stack", "core.compose.yml"), "services: {}\n");
      writeFileSync(join(homeDir, "system", "stack", "services.compose.yml"), "services: {}\n");
      writeFileSync(join(homeDir, "system", "stack", "portals.compose.yml"), "services: {}\n");
      writeFileSync(join(homeDir, "config", "stack", "custom.compose.yml"), "services: {}\n");

      // A fake `docker` on PATH records the argv it was called with instead
      // of touching a real daemon — this test is about the SCRIPT reaching
      // the invocation with the right arguments, not compose itself.
      const recordPath = join(fakeBinDir, "docker-argv.txt");
      const dockerStub = join(fakeBinDir, "docker");
      writeFileSync(dockerStub, ["#!/bin/sh", `echo "$@" > "${recordPath}"`, "exit 0", ""].join("\n"));
      chmodSync(dockerStub, 0o755);

      const inputs: OpenpalmHelperScriptInputs = { ...SAMPLE_INPUTS, renderedOpHome: homeDir };
      const scriptPath = join(homeDir, OPENPALM_SH_FILENAME);
      writeFileSync(scriptPath, buildOpenpalmShellHelper(inputs));
      chmodSync(scriptPath, 0o755);

      const result = spawnSync("bash", [scriptPath, "up"], {
        cwd: homeDir,
        encoding: "utf-8",
        env: { ...process.env, OP_HOME: homeDir, PATH: `${fakeBinDir}:${process.env.PATH ?? ""}` },
      });
      expect(result.status, result.stderr).toBe(0);
      const recordedArgv = readFileSync(recordPath, "utf-8");
      expect(recordedArgv).toContain("compose");
      expect(recordedArgv).toContain("--project-name openpalm");
      expect(recordedArgv).toContain(`-f ${join(homeDir, "system/stack/core.compose.yml")}`);
      expect(recordedArgv).toContain("up -d");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(fakeBinDir, { recursive: true, force: true });
    }
  });
});

describe("buildOpenpalmPowerShellHelper (pure render)", () => {
  it("bakes the resolved OP_HOME, project name, and file list", () => {
    const script = buildOpenpalmPowerShellHelper(SAMPLE_INPUTS);
    expect(script).toContain("$RenderedOpHome = '/home/me/.openpalm'");
    expect(script).toContain("$RenderedProjectName = 'openpalm'");
    for (const f of SAMPLE_INPUTS.relativeFiles) {
      expect(script).toContain(`'${f}'`);
    }
  });

  it("escapes an embedded single quote in a rendered value", () => {
    const script = buildOpenpalmPowerShellHelper({ ...SAMPLE_INPUTS, projectName: "o'brien" });
    expect(script).toContain("$RenderedProjectName = 'o''brien'");
  });
});

describe("renderOpenpalmHelperScripts (real filesystem, matches discoverStackOverlays/resolveComposeProjectName exactly)", () => {
  let homeDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  });

  it("the baked -f list is byte-identical to discoverStackOverlays' own resolution, including a conditional overlay", () => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-render-real-"));
    mkdirSync(join(homeDir, "system", "stack"), { recursive: true });
    mkdirSync(join(homeDir, "config", "stack"), { recursive: true });
    mkdirSync(join(homeDir, "state"), { recursive: true });
    for (const name of ["core.compose.yml", "services.compose.yml", "portals.compose.yml", "guardian.compose.api.yml"]) {
      writeFileSync(join(homeDir, "system", "stack", name), "services: {}\n");
    }
    writeFileSync(join(homeDir, "config", "stack", "custom.compose.yml"), "services: {}\n");
    // Conditional overlay: the api addon toggle. discoverStackOverlays only
    // includes guardian.compose.api.yml when this resolves true.
    writeFileSync(join(homeDir, "state", "stack.env"), "OP_PROJECT_NAME=rendertest\nOP_ACCESS_OPENAI_API=true\n");

    renderOpenpalmHelperScripts(homeDir);

    const expectedFiles = discoverStackOverlays(homeDir);
    expect(expectedFiles.some((f) => f.endsWith("guardian.compose.api.yml"))).toBe(true);
    const expectedProject = resolveComposeProjectName({});

    const shContent = readFileSync(join(homeDir, OPENPALM_SH_FILENAME), "utf-8");
    for (const abs of expectedFiles) {
      const rel = abs.slice(homeDir.length + 1);
      expect(shContent).toContain(`"${rel}"`);
    }
    // resolveComposeProjectName reads OP_PROJECT_NAME from state/stack.env
    // via readStackEnv — same value the render bakes.
    expect(shContent).toContain('RENDERED_PROJECT_NAME="rendertest"');
    void expectedProject;
  });

  it("writes openpalm.sh executable and openpalm.ps1 non-executable, both valid syntax", () => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-render-perms-"));
    mkdirSync(join(homeDir, "system", "stack"), { recursive: true });
    mkdirSync(join(homeDir, "config", "stack"), { recursive: true });
    for (const name of ["core.compose.yml", "services.compose.yml", "portals.compose.yml"]) {
      writeFileSync(join(homeDir, "system", "stack", name), "services: {}\n");
    }
    writeFileSync(join(homeDir, "config", "stack", "custom.compose.yml"), "services: {}\n");

    renderOpenpalmHelperScripts(homeDir);

    const shPath = join(homeDir, OPENPALM_SH_FILENAME);
    const ps1Path = join(homeDir, OPENPALM_PS1_FILENAME);
    const shMode = statSync(shPath).mode & 0o777;
    expect(shMode & 0o100).toBe(0o100); // owner-executable
    expect(existsSync(ps1Path)).toBe(true);

    const syntaxCheck = spawnSync("bash", ["-n", shPath], { encoding: "utf-8" });
    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);
  });

  it("re-renders on a second call, reflecting a changed project name (not seeded-once)", () => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-render-rerender-"));
    mkdirSync(join(homeDir, "system", "stack"), { recursive: true });
    mkdirSync(join(homeDir, "config", "stack"), { recursive: true });
    mkdirSync(join(homeDir, "state"), { recursive: true });
    for (const name of ["core.compose.yml", "services.compose.yml", "portals.compose.yml"]) {
      writeFileSync(join(homeDir, "system", "stack", name), "services: {}\n");
    }
    writeFileSync(join(homeDir, "config", "stack", "custom.compose.yml"), "services: {}\n");
    writeFileSync(join(homeDir, "state", "stack.env"), "OP_PROJECT_NAME=first-name\n");

    renderOpenpalmHelperScripts(homeDir);
    expect(readFileSync(join(homeDir, OPENPALM_SH_FILENAME), "utf-8")).toContain(
      'RENDERED_PROJECT_NAME="first-name"',
    );

    writeFileSync(join(homeDir, "state", "stack.env"), "OP_PROJECT_NAME=renamed-project\n");
    renderOpenpalmHelperScripts(homeDir);
    const rerendered = readFileSync(join(homeDir, OPENPALM_SH_FILENAME), "utf-8");
    expect(rerendered).toContain('RENDERED_PROJECT_NAME="renamed-project"');
    expect(rerendered).not.toContain('RENDERED_PROJECT_NAME="first-name"');
  });
});
