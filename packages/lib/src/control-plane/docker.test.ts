import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildComposePreflightError,
  detectExistingProject,
  isProjectOurs,
  resolveComposeProjectName,
  toDockerResult,
} from "./docker.js";

describe("isProjectOurs (ours-vs-foreign decision)", () => {
  it("treats a matching working_dir as ours", () => {
    expect(isProjectOurs("/home/me/.openpalm", "/home/me/.openpalm")).toBe(true);
  });

  it("treats a different working_dir as foreign", () => {
    expect(isProjectOurs("/home/other/.openpalm", "/home/me/.openpalm")).toBe(false);
  });

  it("treats an empty/unknown working_dir as ours (reconcile, don't refuse)", () => {
    expect(isProjectOurs("", "/home/me/.openpalm")).toBe(true);
    expect(isProjectOurs("   ", "/home/me/.openpalm")).toBe(true);
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
