import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  resolveUiBuildDir, readUiBuildVersion, UI_VERSION_STAMP,
  seedOpenPalmDir, SKELETON_VERSION_STAMP,
  uiUpdateChannel, checkAndUpdateUiBuild,
} from "./ui-assets.js";

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

  it("REFRESHES system-managed stack assets on every seed (even same version), preserving user files (#472)", async () => {
    const core = join(opHome, "config", "stack", "core.compose.yml");
    const custom = join(opHome, "config", "stack", "custom.compose.yml");
    // Skeleton ships the CURRENT managed compose. (custom.compose.yml is user-owned
    // and intentionally not part of the skeleton refresh.)
    writeFileSync(join(repoRoot, ".openpalm", "config", "stack", "core.compose.yml"), "services:\n  assistant:\n    image: current\n");

    // First seed materializes everything + stamps the version.
    await seedOpenPalmDir("v1", opHome, join(opHome, "config"), join(opHome, "data"));

    // Simulate an OLD OP_HOME: a STALE managed compose + a user-owned overlay.
    writeFileSync(core, "services:\n  assistant:\n    image: STALE\n");
    writeFileSync(custom, "services:\n  my-thing:\n    image: user\n");

    // Re-seed the SAME version (stamp matches → the old code skipped entirely).
    await seedOpenPalmDir("v1", opHome, join(opHome, "config"), join(opHome, "data"));

    // Managed asset is refreshed to the shipped version; user file is untouched.
    expect(readFileSync(core, "utf-8")).toContain("image: current");
    expect(readFileSync(core, "utf-8")).not.toContain("STALE");
    expect(readFileSync(custom, "utf-8")).toContain("image: user");
  });
});

// ── uiUpdateChannel ───────────────────────────────────────────────────────────

describe("uiUpdateChannel", () => {
  it("returns 'latest' for a stable version", () => {
    expect(uiUpdateChannel("0.11.0")).toBe("latest");
    expect(uiUpdateChannel("1.0.0")).toBe("latest");
  });

  it("returns 'next' for a prerelease version (contains '-')", () => {
    expect(uiUpdateChannel("0.11.0-rc.2")).toBe("next");
    expect(uiUpdateChannel("0.11.0-beta.5")).toBe("next");
    expect(uiUpdateChannel("1.0.0-alpha.1")).toBe("next");
  });
});

// ── npm integrity verification (via checkAndUpdateUiBuild) ────────────────────
//
// We mock globalThis.fetch to avoid real network calls.  The integrity paths
// are exercised through checkAndUpdateUiBuild → downloadNpmUiBundle (for the
// missing-integrity and mismatch cases) and through checkAndUpdateUiBuild
// returning {updated:false} early (for the up-to-date case).

/** Build a correct sha512 SRI string for the given bytes. */
function makeSri(data: Uint8Array): string {
  const digest = createHash("sha512").update(data).digest("base64");
  return `sha512-${digest}`;
}

describe("npm integrity verification (fail-closed)", () => {
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    // Set forceRemote context: no local build available for these tests.
    // (data/ui has no index.js, bundledUi dir exists but is empty → no local build)
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it("throws when the manifest has no integrity hash (fail-closed)", async () => {
    // manifest fetch returns a version with no integrity
    globalThis.fetch = async (_url: string | URL | Request) => {
      const url = String(typeof _url === "string" ? _url : (_url as Request).url ?? _url);
      if (url.includes("registry.npmjs.org")) {
        return new Response(
          JSON.stringify({
            version: "0.11.0",
            dist: { tarball: "https://registry.npmjs.org/tarball.tgz" },
            // integrity intentionally omitted
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // tarball fetch — should NOT be reached because we throw before it
      return new Response("not-reached", { status: 200 });
    };

    const result = await checkAndUpdateUiBuild("0.11.0-beta.1", join(dataUi, ".."));
    // Missing integrity → non-fatal error path
    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/no integrity hash/i);
  });

  it("throws when the tarball bytes do not match the stated integrity hash", async () => {
    const fakeData = new Uint8Array([1, 2, 3, 4]);
    const wrongSri = `sha512-${Buffer.from("wrong").toString("base64")}`;

    globalThis.fetch = async (_url: string | URL | Request) => {
      const url = String(typeof _url === "string" ? _url : (_url as Request).url ?? _url);
      if (url.includes("registry.npmjs.org") && !url.includes("tarball")) {
        return new Response(
          JSON.stringify({
            version: "0.99.0",  // newer than anything on disk
            dist: { tarball: "https://registry.npmjs.org/tarball.tgz", integrity: wrongSri },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // tarball response — bytes deliberately do NOT match wrongSri
      return new Response(fakeData, { status: 200 });
    };

    const result = await checkAndUpdateUiBuild("0.11.0", join(dataUi, ".."));
    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/integrity mismatch/i);
  });
});

// ── checkAndUpdateUiBuild ─────────────────────────────────────────────────────

describe("checkAndUpdateUiBuild", () => {
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  /** Make a minimal npm manifest response for a given version. */
  function manifestResponse(version: string, integrity?: string) {
    return new Response(
      JSON.stringify({
        version,
        dist: {
          tarball: "https://registry.npmjs.org/tarball.tgz",
          ...(integrity !== undefined ? { integrity } : {}),
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  it("returns {updated:false} when the npm channel version is not newer than on-disk stamp", async () => {
    // Seed data/ui with a stamped build
    makeBuild(dataUi, "0.11.0");

    globalThis.fetch = async () => manifestResponse("0.11.0"); // same version
    const result = await checkAndUpdateUiBuild("0.11.0", join(opHome, "data"));
    expect(result.updated).toBe(false);
    expect(result.latestVersion).toBe("0.11.0");
    expect(result.error).toBeUndefined();
  });

  it("returns {updated:false} when the npm channel version is older than on-disk stamp", async () => {
    makeBuild(dataUi, "0.12.0");

    globalThis.fetch = async () => manifestResponse("0.11.0"); // older
    const result = await checkAndUpdateUiBuild("0.12.0", join(opHome, "data"));
    expect(result.updated).toBe(false);
    expect(result.latestVersion).toBe("0.11.0");
  });

  it("returns {updated:false, error} when the manifest fetch rejects (non-fatal)", async () => {
    globalThis.fetch = async () => { throw new Error("network failure"); };

    const result = await checkAndUpdateUiBuild("0.11.0", join(opHome, "data"));
    expect(result.updated).toBe(false);
    expect(result.latestVersion).toBeNull();
    expect(result.error).toMatch(/network failure/i);
  });

  it("returns {updated:false, error} when the registry returns a non-OK status", async () => {
    globalThis.fetch = async () => new Response("not found", { status: 404 });

    const result = await checkAndUpdateUiBuild("0.11.0", join(opHome, "data"));
    expect(result.updated).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("attempts an update when the on-disk build is unstamped (legacy data/ui)", async () => {
    // Unstamped data/ui — cannot compare, so it should try to refresh from npm.
    // We give it a manifest with missing integrity so it fails non-fatally
    // (avoids needing a real tarball), but we confirm it DID attempt the download.
    makeBuild(dataUi, null); // unstamped

    let manifestFetched = false;
    globalThis.fetch = async (_url: string | URL | Request) => {
      const url = String(typeof _url === "string" ? _url : (_url as Request).url ?? _url);
      if (url.includes("registry.npmjs.org")) {
        manifestFetched = true;
        // Return a manifest without integrity so downloadNpmUiBundle throws
        return manifestResponse("0.11.1");
      }
      return new Response("", { status: 200 });
    };

    const result = await checkAndUpdateUiBuild("0.11.0", join(opHome, "data"));
    expect(manifestFetched).toBe(true);
    // non-fatal: missing integrity → error path
    expect(result.updated).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("attempts an update when npm has a newer version than the on-disk stamp", async () => {
    makeBuild(dataUi, "0.11.0");

    let manifestFetched = false;
    globalThis.fetch = async (_url: string | URL | Request) => {
      const url = String(typeof _url === "string" ? _url : (_url as Request).url ?? _url);
      if (url.includes("registry.npmjs.org")) {
        manifestFetched = true;
        return manifestResponse("0.12.0"); // newer — no integrity → non-fatal error
      }
      return new Response("", { status: 200 });
    };

    const result = await checkAndUpdateUiBuild("0.11.0", join(opHome, "data"));
    expect(manifestFetched).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/no integrity hash/i);
  });

  it('does not auto-update the UI across a major version boundary', async () => {
    makeBuild(dataUi, '0.11.0');

    let tarballFetched = false;
    globalThis.fetch = async (_url: string | URL | Request) => {
      const url = String(typeof _url === 'string' ? _url : (_url as Request).url ?? _url);
      if (url.includes('registry.npmjs.org')) {
        return manifestResponse('1.0.0');
      }
      tarballFetched = true;
      return new Response('', { status: 200 });
    };

    const result = await checkAndUpdateUiBuild('0.11.0', join(opHome, 'data'));
    expect(result.updated).toBe(false);
    expect(result.latestVersion).toBe('1.0.0');
    expect(result.error).toBeUndefined();
    expect(tarballFetched).toBe(false);
  });

  it('uses the app major as the fallback policy base for unstamped UI builds', async () => {
    makeBuild(dataUi, null);

    let tarballFetched = false;
    globalThis.fetch = async (_url: string | URL | Request) => {
      const url = String(typeof _url === 'string' ? _url : (_url as Request).url ?? _url);
      if (url.includes('registry.npmjs.org')) {
        return manifestResponse('1.0.0');
      }
      tarballFetched = true;
      return new Response('', { status: 200 });
    };

    const result = await checkAndUpdateUiBuild('0.11.0', join(opHome, 'data'));
    expect(result.updated).toBe(false);
    expect(result.latestVersion).toBe('1.0.0');
    expect(result.error).toBeUndefined();
    expect(tarballFetched).toBe(false);
  });
});
