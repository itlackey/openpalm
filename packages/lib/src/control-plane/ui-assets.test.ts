import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { resolveUiBuildDir, readUiBuildVersion, UI_VERSION_STAMP, seedOpenPalmDir, SKELETON_VERSION_STAMP } from "./ui-assets.js";

let root = "";
let opHome = "";
let repoRoot = "";
let dataUi = "";
let bundledUi = "";
const saved: Record<string, string | undefined> = {};

function makeBuild(dir: string, version: string | null): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), "// ui server\n");
  if (version !== null) writeFileSync(join(dir, UI_VERSION_STAMP), `${version}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ui-assets-"));
  opHome = join(root, "ophome");
  repoRoot = join(root, "repo");
  dataUi = join(opHome, "data", "ui");
  bundledUi = join(repoRoot, "packages", "ui", "build"); // resolveLocalUiBuild() candidate 1
  saved.OP_HOME = process.env.OP_HOME;
  saved.OPENPALM_REPO_ROOT = process.env.OPENPALM_REPO_ROOT;
  process.env.OP_HOME = opHome;
  // Pin the bundled candidate to a controlled location so the resolver never
  // discovers the real packages/ui/build via its source-relative fallback.
  // Default: an EMPTY build dir (exists but no index.js) = "no bundled build".
  process.env.OPENPALM_REPO_ROOT = repoRoot;
  mkdirSync(bundledUi, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ["OP_HOME", "OPENPALM_REPO_ROOT"] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("readUiBuildVersion", () => {
  it("reads the stamp, or null when absent", () => {
    makeBuild(dataUi, "0.11.0");
    expect(readUiBuildVersion(dataUi)).toBe("0.11.0");
    makeBuild(bundledUi, null);
    expect(readUiBuildVersion(bundledUi)).toBeNull();
  });
});

describe("resolveUiBuildDir — version-aware selection", () => {
  it("uses data/ui when only it exists", () => {
    makeBuild(dataUi, "0.11.0");
    expect(resolveUiBuildDir()).toBe(dataUi);
  });

  it("uses bundled when only it exists", () => {
    makeBuild(bundledUi, "0.11.0");
    process.env.OPENPALM_REPO_ROOT = repoRoot;
    expect(resolveUiBuildDir()).toBe(bundledUi);
  });

  it("prefers data/ui only when it is strictly NEWER than bundled", () => {
    makeBuild(dataUi, "0.12.0");
    makeBuild(bundledUi, "0.11.0");
    process.env.OPENPALM_REPO_ROOT = repoRoot;
    expect(resolveUiBuildDir()).toBe(dataUi);
  });

  it("prefers bundled when it is newer than data/ui (fixes stale-data/ui shadowing)", () => {
    makeBuild(dataUi, "0.11.0");
    makeBuild(bundledUi, "0.12.0");
    process.env.OPENPALM_REPO_ROOT = repoRoot;
    expect(resolveUiBuildDir()).toBe(bundledUi);
  });

  it("prefers bundled when versions are equal", () => {
    makeBuild(dataUi, "0.11.0");
    makeBuild(bundledUi, "0.11.0");
    process.env.OPENPALM_REPO_ROOT = repoRoot;
    expect(resolveUiBuildDir()).toBe(bundledUi);
  });

  it("prefers bundled when data/ui is unstamped (cannot prove it is newer)", () => {
    makeBuild(dataUi, null);
    makeBuild(bundledUi, "0.11.0");
    process.env.OPENPALM_REPO_ROOT = repoRoot;
    expect(resolveUiBuildDir()).toBe(bundledUi);
  });

  it("falls back to the data/ui path when nothing is present (caller seeds)", () => {
    expect(resolveUiBuildDir()).toBe(dataUi);
  });
});

describe("seedOpenPalmDir — version guard (P2)", () => {
  const seededFile = () => join(opHome, "config", "stack", "x.txt");
  const stamp = () => join(opHome, SKELETON_VERSION_STAMP);

  beforeEach(() => {
    // Local skeleton source at OPENPALM_REPO_ROOT/.openpalm (candidate 1).
    mkdirSync(join(repoRoot, ".openpalm", "config", "stack"), { recursive: true });
    writeFileSync(join(repoRoot, ".openpalm", "config", "stack", "x.txt"), "seed\n");
    mkdirSync(opHome, { recursive: true });
  });

  it("seeds once and stamps the version", async () => {
    await seedOpenPalmDir("v1", opHome, join(opHome, "config"), join(opHome, "data"));
    expect(existsSync(seededFile())).toBe(true);
    expect(readFileSync(stamp(), "utf-8").trim()).toBe("v1");
  });

  it("does NOT re-seed (or re-materialize a removed file) for the same version", async () => {
    await seedOpenPalmDir("v1", opHome, join(opHome, "config"), join(opHome, "data"));
    rmSync(seededFile(), { force: true });
    await seedOpenPalmDir("v1", opHome, join(opHome, "config"), join(opHome, "data"));
    expect(existsSync(seededFile())).toBe(false); // guard skipped the copy
  });

  it("re-seeds on a version change", async () => {
    await seedOpenPalmDir("v1", opHome, join(opHome, "config"), join(opHome, "data"));
    rmSync(seededFile(), { force: true });
    await seedOpenPalmDir("v2", opHome, join(opHome, "config"), join(opHome, "data"));
    expect(existsSync(seededFile())).toBe(true);
    expect(readFileSync(stamp(), "utf-8").trim()).toBe("v2");
  });
});
