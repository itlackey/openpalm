import { afterEach, describe, expect, it } from "bun:test";
import {
  detectExistingProject,
  isProjectOurs,
  resolveComposeProjectName,
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
