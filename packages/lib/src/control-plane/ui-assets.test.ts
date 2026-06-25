import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  resolveUiBuildDir, readUiBuildVersion, UI_VERSION_STAMP,
  seedOpenPalmDir, SKELETON_VERSION_STAMP,
  uiUpdateChannel, checkAndUpdateUiBuild, declaredUiChannel,
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
  saved.OP_UI_CHANNEL = process.env.OP_UI_CHANNEL;
  delete process.env.OP_UI_CHANNEL;
  process.env.OP_HOME = opHome;
  // Pin the bundled candidate to a controlled location so the resolver never
  // discovers the real packages/ui/build via its source-relative fallback.
  // Default: an EMPTY build dir (exists but no index.js) = "no bundled build".
  process.env.OPENPALM_REPO_ROOT = repoRoot;
  mkdirSync(bundledUi, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ["OP_HOME", "OPENPALM_REPO_ROOT", "OP_UI_CHANNEL"] as const) {
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

describe("resolveUiBuildDir — de-route visibility (§6.1 / Risk #1)", () => {
  it("WARNS that the downloaded control plane is NOT executing when data/ui is present but UNSTAMPED", () => {
    makeBuild(dataUi, null);          // present, runnable, but no version stamp
    makeBuild(bundledUi, "0.11.0");
    process.env.OPENPALM_REPO_ROOT = repoRoot;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveUiBuildDir()).toBe(bundledUi); // de-routes to frozen bundled
      const logged = errSpy.mock.calls.map(c => String(c[0])).join("\n");
      expect(logged).toContain("UNSTAMPED");
      expect(logged).toContain("NOT executing");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("WARNS (not-newer variant) when data/ui is stamped but not strictly newer", () => {
    makeBuild(dataUi, "0.11.0");
    makeBuild(bundledUi, "0.11.0");   // equal → bundled wins, data/ui de-routed
    process.env.OPENPALM_REPO_ROOT = repoRoot;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveUiBuildDir()).toBe(bundledUi);
      const logged = errSpy.mock.calls.map(c => String(c[0])).join("\n");
      expect(logged).toContain("not strictly newer");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("does NOT warn when data/ui legitimately wins", () => {
    makeBuild(dataUi, "0.12.0");
    makeBuild(bundledUi, "0.11.0");
    process.env.OPENPALM_REPO_ROOT = repoRoot;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveUiBuildDir()).toBe(dataUi);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("seedOpenPalmDir — version guard (P2)", () => {
  // A USER-tree seed marker: seeded once by the version-gated copyTree, so a
  // removed copy stays removed on a same-version re-seed. (system/ files are
  // ALWAYS overwritten by overwriteSystemTree and are NOT valid seed-once markers.)
  const seededFile = () => join(opHome, "config", "marker.txt");
  const stamp = () => join(opHome, SKELETON_VERSION_STAMP);

  beforeEach(() => {
    // Local skeleton source at OPENPALM_REPO_ROOT/packages/skeleton (candidate 1).
    mkdirSync(join(repoRoot, "packages", "skeleton", "system", "stack"), { recursive: true });
    writeFileSync(join(repoRoot, "packages", "skeleton", "system", "stack", "x.txt"), "seed\n");
    // overwriteSystemTree blind-copies ALL of system/ from the source; populate it.
    writeFileSync(join(repoRoot, "packages", "skeleton", "system", "stack", "core.compose.yml"), "services: {}\n");
    writeFileSync(join(repoRoot, "packages", "skeleton", "system", "stack", "services.compose.yml"), "services: {}\n");
    writeFileSync(join(repoRoot, "packages", "skeleton", "system", "stack", "portals.compose.yml"), "services: {}\n");
    // USER-owned seeds (seed-once via copyTree): the custom overlay + a marker.
    mkdirSync(join(repoRoot, "packages", "skeleton", "config", "stack"), { recursive: true });
    writeFileSync(join(repoRoot, "packages", "skeleton", "config", "stack", "custom.compose.yml"), "services: {}\n");
    writeFileSync(join(repoRoot, "packages", "skeleton", "config", "marker.txt"), "user-seed\n");
    // Skeleton ships per-service tool manifests under data/<svc>/tools/package.json.
    // These are seeded ONLY by the full copyTree(skipExisting) on a version change,
    // NOT by refreshCoreAssetsFromSource (which only covers system/stack/*).
    for (const svc of ["guardian", "assistant", "portal"]) {
      mkdirSync(join(repoRoot, "packages", "skeleton", "data", svc, "tools"), { recursive: true });
      writeFileSync(
        join(repoRoot, "packages", "skeleton", "data", svc, "tools", "package.json"),
        `{ "name": "${svc}-tools" }\n`,
      );
    }
    mkdirSync(opHome, { recursive: true });
  });

  const toolsPkg = (svc: string) => join(opHome, "data", svc, "tools", "package.json");

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

  it("OVERWRITES the managed system/ tree on every seed (even same version), preserving user files (#472)", async () => {
    const core = join(opHome, "system", "stack", "core.compose.yml");
    const custom = join(opHome, "config", "stack", "custom.compose.yml"); // USER-owned
    // Skeleton ships the CURRENT managed compose.
    writeFileSync(join(repoRoot, "packages", "skeleton", "system", "stack", "core.compose.yml"), "services:\n  assistant:\n    image: current\n");

    // First seed materializes everything + stamps the version.
    await seedOpenPalmDir("v1", opHome, join(opHome, "config"), join(opHome, "data"));

    // Simulate an OLD OP_HOME: a STALE managed compose + a user-owned overlay edit.
    writeFileSync(core, "services:\n  assistant:\n    image: STALE\n");
    writeFileSync(custom, "services:\n  my-thing:\n    image: user\n");

    // Re-seed the SAME version (stamp matches → the old code skipped entirely).
    await seedOpenPalmDir("v1", opHome, join(opHome, "config"), join(opHome, "data"));

    // Managed system/ asset is overwritten to the shipped version; the user file
    // in config/ is untouched (seed-once, never overwritten).
    expect(readFileSync(core, "utf-8")).toContain("image: current");
    expect(readFileSync(core, "utf-8")).not.toContain("STALE");
    expect(readFileSync(custom, "utf-8")).toContain("image: user");
  });

  it("seeds data/<svc>/tools/package.json into an OP_HOME stamped at an OLDER skeleton version (regression)", async () => {
    // Reproduces the bug that started the reconcile refactor: data/<svc>/tools/
    // package.json is materialized ONLY by the version-gated full copyTree, never
    // by the always-on refreshCoreAssetsFromSource. So an OP_HOME stamped at an
    // older skeleton version (an upgraded install) never received these files —
    // the guardian container then failed with "opencode not on PATH".

    // 1. Seed at the OLD version, then DELETE the tool manifests to simulate an
    //    OP_HOME that predates them (older skeleton shipped no data/<svc>/tools).
    await seedOpenPalmDir("v0", opHome, join(opHome, "config"), join(opHome, "data"));
    for (const svc of ["guardian", "assistant", "portal"]) {
      rmSync(toolsPkg(svc), { force: true });
      expect(existsSync(toolsPkg(svc))).toBe(false);
    }

    // 2. Reconcile to the NEW platform version (stamp changes → full seed runs).
    await seedOpenPalmDir("v1", opHome, join(opHome, "config"), join(opHome, "data"));

    // 3. The missing tool manifests are now materialized for every service.
    for (const svc of ["guardian", "assistant", "portal"]) {
      expect(existsSync(toolsPkg(svc)), `data/${svc}/tools/package.json must be seeded`).toBe(true);
      expect(readFileSync(toolsPkg(svc), "utf-8")).toContain(`${svc}-tools`);
    }
    expect(readFileSync(stamp(), "utf-8").trim()).toBe("v1");
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

  it("an explicit channel ARGUMENT overrides the version-derived default", () => {
    // A stable host opts into 'next' without faking its version.
    expect(uiUpdateChannel("0.11.0", "next")).toBe("next");
    // A prerelease host pins to 'latest'.
    expect(uiUpdateChannel("0.11.0-rc.2", "latest")).toBe("latest");
  });

  it("OP_UI_CHANNEL overrides the version-derived default (declared channel)", () => {
    process.env.OP_UI_CHANNEL = "next";
    expect(uiUpdateChannel("0.11.0")).toBe("next");   // stable version, declared next
    process.env.OP_UI_CHANNEL = "latest";
    expect(uiUpdateChannel("0.11.0-rc.2")).toBe("latest");
  });

  it("a passed channel argument wins over OP_UI_CHANNEL", () => {
    process.env.OP_UI_CHANNEL = "next";
    expect(uiUpdateChannel("0.11.0", "latest")).toBe("latest");
  });

  it("an invalid/blank OP_UI_CHANNEL is ignored (falls back to version)", () => {
    process.env.OP_UI_CHANNEL = "bogus";
    expect(uiUpdateChannel("0.11.0")).toBe("latest");
    expect(uiUpdateChannel("0.11.0-rc.2")).toBe("next");
    process.env.OP_UI_CHANNEL = "  ";
    expect(uiUpdateChannel("0.11.0-rc.2")).toBe("next");
  });
});

describe("declaredUiChannel", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.OP_UI_CHANNEL; });
  afterEach(() => {
    if (saved === undefined) delete process.env.OP_UI_CHANNEL;
    else process.env.OP_UI_CHANNEL = saved;
  });
  it("returns the declared channel, case-insensitively", () => {
    process.env.OP_UI_CHANNEL = "NEXT";
    expect(declaredUiChannel()).toBe("next");
    process.env.OP_UI_CHANNEL = "Latest";
    expect(declaredUiChannel()).toBe("latest");
  });
  it("returns null when unset or invalid", () => {
    delete process.env.OP_UI_CHANNEL;
    expect(declaredUiChannel()).toBeNull();
    process.env.OP_UI_CHANNEL = "beta";
    expect(declaredUiChannel()).toBeNull();
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
  function manifestResponse(version: string, integrity?: string, minHarnessContract?: number) {
    return new Response(
      JSON.stringify({
        version,
        ...(minHarnessContract !== undefined ? { minHarnessContract } : {}),
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

  // ── Regression: prerelease versions must use the `next` npm dist-tag channel ──
  // This test ensures that prerelease app versions (containing '-') correctly
  // query the npm `next` channel for UI updates, not `latest`. The `latest`
  // channel excludes prereleases, so a prerelease app would incorrectly see
  // "no update available" if it queried `latest`.

  it('checkAndUpdateUiBuild uses `next` channel for prerelease app versions', async () => {
    makeBuild(dataUi, '0.11.0');

    let requestedChannel: string | null = null;
    globalThis.fetch = async (_url: string | URL | Request) => {
      const url = String(typeof _url === 'string' ? _url : (_url as Request).url ?? _url);
      if (url.includes('registry.npmjs.org/@openpalm/ui/')) {
        requestedChannel = url.split('/@openpalm/ui/')[1];
        return manifestResponse('0.12.0-rc.1');
      }
      return new Response('', { status: 200 });
    };

    // Call with a prerelease version — should query the `next` channel
    await checkAndUpdateUiBuild('0.12.0-rc.1', join(opHome, 'data'));
    expect(requestedChannel).toBe('next');
  });

  it('checkAndUpdateUiBuild uses `latest` channel for stable app versions', async () => {
    makeBuild(dataUi, '0.11.0');

    let requestedChannel: string | null = null;
    globalThis.fetch = async (_url: string | URL | Request) => {
      const url = String(typeof _url === 'string' ? _url : (_url as Request).url ?? _url);
      if (url.includes('registry.npmjs.org/@openpalm/ui/')) {
        requestedChannel = url.split('/@openpalm/ui/')[1];
        return manifestResponse('0.12.0');
      }
      return new Response('', { status: 200 });
    };

    // Call with a stable version — should query the `latest` channel
    await checkAndUpdateUiBuild('0.12.0', join(opHome, 'data'));
    expect(requestedChannel).toBe('latest');
  });

  // ── §5.3 / §6.6 self-update-vs-redownload decision ──────────────────────────
  // When a newer UI build declares minHarnessContract > the harness contract the
  // running app provides, the control plane must NOT be pulled (running
  // newer-UI-on-older-harness fails at runtime: undefined IPC → TypeError, missing
  // env → 503). The caller is told to re-download the app instead.
  describe('harness-contract self-update gate (§5.3)', () => {
    it('refuses to self-update when the newer UI needs a harness contract this app does not provide', async () => {
      makeBuild(dataUi, '0.12.0');

      let tarballFetched = false;
      globalThis.fetch = async (_url: string | URL | Request) => {
        const url = String(typeof _url === 'string' ? _url : (_url as Request).url ?? _url);
        if (url.includes('registry.npmjs.org')) {
          return manifestResponse('0.13.0', undefined, 2); // needs harness contract 2
        }
        tarballFetched = true;
        return new Response('', { status: 200 });
      };

      // Running harness provides contract 1; the build needs 2 → re-download.
      const result = await checkAndUpdateUiBuild('0.12.0', join(opHome, 'data'), undefined, 1);
      expect(result.updated).toBe(false);
      expect(result.redownloadRequired).toBe(true);
      expect(result.requiredHarnessContract).toBe(2);
      expect(result.latestVersion).toBe('0.13.0');
      expect(tarballFetched).toBe(false); // never even attempted the download
    });

    it('self-updates when the newer UI fits the harness contract (minHarnessContract <= provided)', async () => {
      makeBuild(dataUi, '0.12.0');

      let manifestFetched = false;
      globalThis.fetch = async (_url: string | URL | Request) => {
        const url = String(typeof _url === 'string' ? _url : (_url as Request).url ?? _url);
        if (url.includes('registry.npmjs.org')) {
          manifestFetched = true;
          return manifestResponse('0.12.5', undefined, 1); // needs contract 1, no integrity → non-fatal
        }
        return new Response('', { status: 200 });
      };

      // Harness provides contract 1; build needs 1 → gate passes, proceeds to download
      // (which fails non-fatally on the missing integrity hash — proving the gate let it through).
      const result = await checkAndUpdateUiBuild('0.12.0', join(opHome, 'data'), undefined, 1);
      expect(manifestFetched).toBe(true);
      expect(result.redownloadRequired).toBeUndefined();
      expect(result.error).toMatch(/no integrity hash/i);
    });

    it('skips the gate entirely on non-Electron supervisors (no harness contract supplied)', async () => {
      makeBuild(dataUi, '0.12.0');

      let manifestFetched = false;
      globalThis.fetch = async (_url: string | URL | Request) => {
        const url = String(typeof _url === 'string' ? _url : (_url as Request).url ?? _url);
        if (url.includes('registry.npmjs.org')) {
          manifestFetched = true;
          return manifestResponse('0.12.5', undefined, 99); // huge contract requirement
        }
        return new Response('', { status: 200 });
      };

      // CLI passes no harnessContract → gate is skipped even though minHarnessContract is huge.
      const result = await checkAndUpdateUiBuild('0.12.0', join(opHome, 'data'));
      expect(manifestFetched).toBe(true);
      expect(result.redownloadRequired).toBeUndefined();
      expect(result.error).toMatch(/no integrity hash/i); // proceeded past the gate to the download
    });
  });
});
