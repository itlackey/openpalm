// ── P5c RED TESTS (#555) — client-build resolution + seeding ─────────────────
//
// These tests pin the lib surface for serving `@openpalm/client` from the
// harness (plan Phase 5 item 3; phase-5-completion-guide §4 P5c item 1):
// a THIN SIBLING of ui-assets.ts that reuses npm-bundle-updater (never forks it).
//
// Pinned design decisions (the tests are the contract):
//   • Module: `client-assets.ts` next to `ui-assets.ts` (same barrel re-export
//     pattern; these imports fail until the module exists — that is the red).
//   • On-disk layout: the client artifact keeps the npm package's root shape —
//     `<root>/build/` (static files; gate file `index.html`) and
//     `<root>/bin/serve.mjs` (the zero-dependency static server the CLI spawns).
//     Channels:
//       data channel    → OP_HOME/data/client/{build,bin}
//       dev override    → $OPENPALM_REPO_ROOT/packages/client/{build,bin}
//     This is forced by "bin/serve.mjs from the resolved client build": the
//     serve script must travel WITH the updatable artifact so a compiled CLI
//     binary can run it in every channel, and `join(buildDir, '..', 'bin',
//     'serve.mjs')` holds in both channels.
//   • resolveClientBuildDir() returns the BUILD dir (…/client/build), with the
//     same version-aware two-channel selection as resolveUiBuildDir (data wins
//     only when strictly newer per the stamp).
//   • Version stamp: `.openpalm-client-version` INSIDE the build dir — written
//     by packages/client/scripts/stamp-version.mjs, so the constant here is a
//     cross-package contract.
//   • seedClientBuild(repoRef, dataDir, options?) — local-or-download like
//     seedUiBuild, but with NO harness-contract gate: the client is a static
//     bundle with no native bridge to outgrow.
//   • checkAndUpdateClientBuild(appVersion, dataDir, channelOverride?) —
//     channel/verify/stage/swap/backup pipeline via checkAndUpdateNpmBundle,
//     integrity fail-closed, never crosses a major, non-fatal errors.
//
// Test patterns follow ui-assets.test.ts (env pinning, makeBuild, mocked fetch,
// real tarball for the happy path).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  CLIENT_VERSION_STAMP,
  readClientBuildVersion,
  resolveClientBuildDir,
  seedClientBuild,
  checkAndUpdateClientBuild,
} from "./client-assets.js";

let root = "";
let opHome = "";
let repoRoot = "";
let dataDir = "";
/** Data-channel build dir: OP_HOME/data/client/build */
let dataClient = "";
/** Data-channel package root: OP_HOME/data/client */
let dataClientRoot = "";
/** Dev-override build dir: $OPENPALM_REPO_ROOT/packages/client/build */
let bundledClient = "";
const saved: Record<string, string | undefined> = {};

/** Materialize a static client build: index.html + optional version stamp. */
function makeBuild(dir: string, version: string | null): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>client</title>\n");
  if (version !== null) writeFileSync(join(dir, ".openpalm-client-version"), `${version}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "client-assets-"));
  opHome = join(root, "ophome");
  repoRoot = join(root, "repo");
  dataDir = join(opHome, "data");
  dataClientRoot = join(dataDir, "client");
  dataClient = join(dataClientRoot, "build");
  bundledClient = join(repoRoot, "packages", "client", "build");
  saved.OP_HOME = process.env.OP_HOME;
  saved.OPENPALM_REPO_ROOT = process.env.OPENPALM_REPO_ROOT;
  saved.OP_UI_CHANNEL = process.env.OP_UI_CHANNEL;
  delete process.env.OP_UI_CHANNEL;
  process.env.OP_HOME = opHome;
  // Pin the bundled candidate to a controlled location so the resolver never
  // discovers the REAL packages/client/build via a source-relative fallback
  // (same pinning trick as ui-assets.test.ts). Default: an EMPTY build dir
  // (exists but no index.html) = "no bundled build".
  process.env.OPENPALM_REPO_ROOT = repoRoot;
  mkdirSync(bundledClient, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ["OP_HOME", "OPENPALM_REPO_ROOT", "OP_UI_CHANNEL"] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ── Version stamp ─────────────────────────────────────────────────────────────

describe("CLIENT_VERSION_STAMP / readClientBuildVersion", () => {
  it("CLIENT_VERSION_STAMP matches the filename packages/client/scripts/stamp-version.mjs writes", () => {
    // Cross-package contract: the client build script stamps
    // build/.openpalm-client-version; lib must read the SAME filename.
    expect(CLIENT_VERSION_STAMP).toBe(".openpalm-client-version");
  });

  it("reads the stamp, or null when absent", () => {
    makeBuild(dataClient, "0.12.0");
    expect(readClientBuildVersion(dataClient)).toBe("0.12.0");
    makeBuild(bundledClient, null);
    expect(readClientBuildVersion(bundledClient)).toBeNull();
  });
});

// ── resolveClientBuildDir — version-aware selection (mirrors resolveUiBuildDir) ─

describe("resolveClientBuildDir — version-aware selection", () => {
  it("uses data/client/build when only it exists", () => {
    makeBuild(dataClient, "0.12.0");
    expect(resolveClientBuildDir()).toBe(dataClient);
  });

  it("uses the bundled (OPENPALM_REPO_ROOT) build when only it exists", () => {
    makeBuild(bundledClient, "0.12.0");
    expect(resolveClientBuildDir()).toBe(bundledClient);
  });

  it("prefers data/client/build only when it is strictly NEWER than bundled", () => {
    makeBuild(dataClient, "0.13.0");
    makeBuild(bundledClient, "0.12.0");
    expect(resolveClientBuildDir()).toBe(dataClient);
  });

  it("prefers bundled when it is newer than data (no stale-data shadowing)", () => {
    makeBuild(dataClient, "0.12.0");
    makeBuild(bundledClient, "0.13.0");
    expect(resolveClientBuildDir()).toBe(bundledClient);
  });

  it("prefers bundled when versions are equal", () => {
    makeBuild(dataClient, "0.12.0");
    makeBuild(bundledClient, "0.12.0");
    expect(resolveClientBuildDir()).toBe(bundledClient);
  });

  it("prefers bundled when data is unstamped (cannot prove it is newer)", () => {
    makeBuild(dataClient, null);
    makeBuild(bundledClient, "0.12.0");
    expect(resolveClientBuildDir()).toBe(bundledClient);
  });

  it("falls back to the data path when nothing is present (caller seeds)", () => {
    expect(resolveClientBuildDir()).toBe(dataClient);
  });
});

// ── seedClientBuild ───────────────────────────────────────────────────────────

describe("seedClientBuild", () => {
  it("seeds BOTH build/ and bin/serve.mjs from a local checkout into data/client", async () => {
    // Local dev-override source: build + the sibling serve script. The serve
    // script must travel with the seeded artifact — the CLI runs
    // data/client/bin/serve.mjs, and a compiled binary has no other copy.
    makeBuild(bundledClient, "0.12.52");
    const bundledBin = join(repoRoot, "packages", "client", "bin");
    mkdirSync(bundledBin, { recursive: true });
    writeFileSync(join(bundledBin, "serve.mjs"), "// client static server\n");

    await seedClientBuild("v0.12.52", dataDir);

    expect(existsSync(join(dataClient, "index.html"))).toBe(true);
    expect(existsSync(join(dataClientRoot, "bin", "serve.mjs"))).toBe(true);
    expect(readClientBuildVersion(dataClient)).toBe("0.12.52");
  });

  it("remote seed targets @openpalm/client on npm and fails CLOSED on a missing integrity hash", async () => {
    const requested: string[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request) => {
      const url = String(typeof _url === "string" ? _url : (_url as Request).url ?? _url);
      if (url.includes("registry.npmjs.org")) {
        requested.push(url);
        return new Response(
          JSON.stringify({
            version: "0.13.0",
            // integrity intentionally omitted → the download must refuse
            dist: { tarball: "https://registry.npmjs.org/client.tgz" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not-reached", { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      await expect(
        seedClientBuild("latest", dataDir, { forceRemote: true }),
      ).rejects.toThrow(/no integrity hash/i);
      // Pins the package coordinate: the manifest fetch is for @openpalm/client.
      expect(requested.some((u) => u.includes("/@openpalm/client/"))).toBe(true);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── checkAndUpdateClientBuild ─────────────────────────────────────────────────

describe("checkAndUpdateClientBuild", () => {
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    mkdirSync(join(dataDir, "backups"), { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  function manifestResponse(version: string, integrity?: string) {
    return new Response(
      JSON.stringify({
        version,
        dist: {
          tarball: "https://registry.npmjs.org/client.tgz",
          ...(integrity !== undefined ? { integrity } : {}),
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  it("returns {updated:false} when the npm channel version is not newer than the on-disk stamp", async () => {
    makeBuild(dataClient, "0.12.0");
    globalThis.fetch = (async () => manifestResponse("0.12.0")) as typeof globalThis.fetch;
    const result = await checkAndUpdateClientBuild("0.12.0", dataDir);
    expect(result.updated).toBe(false);
    expect(result.latestVersion).toBe("0.12.0");
    expect(result.error).toBeUndefined();
  });

  it("returns {updated:false} when npm has an older version", async () => {
    makeBuild(dataClient, "0.13.0");
    globalThis.fetch = (async () => manifestResponse("0.12.0")) as typeof globalThis.fetch;
    const result = await checkAndUpdateClientBuild("0.13.0", dataDir);
    expect(result.updated).toBe(false);
    expect(result.latestVersion).toBe("0.12.0");
  });

  it("returns {updated:false, error} when the manifest fetch rejects (non-fatal)", async () => {
    globalThis.fetch = (async () => { throw new Error("network failure"); }) as typeof globalThis.fetch;
    const result = await checkAndUpdateClientBuild("0.12.0", dataDir);
    expect(result.updated).toBe(false);
    expect(result.latestVersion).toBeNull();
    expect(result.error).toMatch(/network failure/i);
  });

  it("fails closed when the manifest has no integrity hash", async () => {
    makeBuild(dataClient, "0.12.0");
    globalThis.fetch = (async (_url: string | URL | Request) => {
      const url = String(typeof _url === "string" ? _url : (_url as Request).url ?? _url);
      if (url.includes("registry.npmjs.org")) return manifestResponse("0.13.0"); // no integrity
      return new Response("", { status: 200 });
    }) as typeof globalThis.fetch;
    const result = await checkAndUpdateClientBuild("0.12.0", dataDir);
    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/no integrity hash/i);
  });

  it("never auto-crosses a major version boundary", async () => {
    makeBuild(dataClient, "0.12.0");
    let tarballFetched = false;
    globalThis.fetch = (async (_url: string | URL | Request) => {
      const url = String(typeof _url === "string" ? _url : (_url as Request).url ?? _url);
      if (url.includes("registry.npmjs.org")) return manifestResponse("1.0.0", "sha512-abc");
      tarballFetched = true;
      return new Response("", { status: 200 });
    }) as typeof globalThis.fetch;
    const result = await checkAndUpdateClientBuild("0.12.0", dataDir);
    expect(result.updated).toBe(false);
    expect(result.latestVersion).toBe("1.0.0");
    expect(result.error).toBeUndefined();
    expect(tarballFetched).toBe(false);
  });

  it("stable → @latest dist-tag; prerelease → newest version across ALL dist-tags (not the stale `next` tag)", async () => {
    makeBuild(dataClient, "0.12.0");
    const refs: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request) => {
      const url = String(typeof _url === "string" ? _url : (_url as Request).url ?? _url);
      if (url.includes("/dist-tags")) {
        // `next` deliberately stale — the shared resolver must pick max(dist-tags).
        return new Response(
          JSON.stringify({ next: "0.12.0-rc.1", beta: "0.12.5-beta.2", latest: "0.12.4" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/@openpalm/client/")) {
        refs.push(url.split("/@openpalm/client/")[1] ?? "");
        return manifestResponse("0.12.0"); // up to date → no download attempted
      }
      return new Response("", { status: 200 });
    }) as typeof globalThis.fetch;
    await checkAndUpdateClientBuild("0.12.4", dataDir);       // stable → latest
    await checkAndUpdateClientBuild("0.12.0-rc.1", dataDir);  // prerelease → next channel
    expect(refs[0]).toBe("latest");
    expect(refs[1]).toBe("0.12.5-beta.2");
  });

  it("happy path: verifies integrity, swaps build/ + bin/, keeps the shipped stamp, and backs up the old artifact", async () => {
    // Plant the OLD artifact in the data channel (build + serve script).
    makeBuild(dataClient, "0.12.0");
    writeFileSync(join(dataClient, "index.html"), "<!doctype html><!-- old -->\n");
    mkdirSync(join(dataClientRoot, "bin"), { recursive: true });
    writeFileSync(join(dataClientRoot, "bin", "serve.mjs"), "// old serve\n");

    // Build a minimal valid @openpalm/client tarball (npm wraps under package/;
    // `files: ["build", "bin"]` publishes exactly these two trees, and the build
    // script stamps build/.openpalm-client-version before publish).
    const pkgRoot = mkdtempSync(join(tmpdir(), "client-happy-pkg-"));
    mkdirSync(join(pkgRoot, "package", "build"), { recursive: true });
    mkdirSync(join(pkgRoot, "package", "bin"), { recursive: true });
    writeFileSync(join(pkgRoot, "package", "build", "index.html"), "<!doctype html><!-- new -->\n");
    writeFileSync(join(pkgRoot, "package", "build", ".openpalm-client-version"), "0.13.0\n");
    writeFileSync(join(pkgRoot, "package", "bin", "serve.mjs"), "// new serve\n");
    const tarPath = join(pkgRoot, "client.tgz");
    const { exited } = Bun.spawn(["tar", "-czf", tarPath, "-C", pkgRoot, "package"], { stdout: "pipe", stderr: "pipe" });
    await exited;
    const tarBytes = new Uint8Array(await Bun.file(tarPath).arrayBuffer());
    const integrity = `sha512-${createHash("sha512").update(tarBytes).digest("base64")}`;
    rmSync(pkgRoot, { recursive: true, force: true });

    globalThis.fetch = (async (_url: string | URL | Request) => {
      const url = String(typeof _url === "string" ? _url : (_url as Request).url ?? _url);
      if (url.includes("registry.npmjs.org")) {
        return new Response(
          JSON.stringify({ version: "0.13.0", dist: { tarball: "https://r.npm/client.tgz", integrity } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(tarBytes, { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await checkAndUpdateClientBuild("0.12.0", dataDir);

    expect(result.updated).toBe(true);
    expect(result.latestVersion).toBe("0.13.0");
    expect(result.error).toBeUndefined();
    // New static build + serve script are in place; the shipped stamp reads back.
    expect(readFileSync(join(dataClient, "index.html"), "utf8")).toContain("new");
    expect(existsSync(join(dataClientRoot, "bin", "serve.mjs"))).toBe(true);
    expect(readClientBuildVersion(dataClient)).toBe("0.13.0");
    // The OLD artifact was backed up under data/backups/client-<ts>/ (same
    // pattern as the UI/skeleton backups) so a supervisor can restore it if the
    // new build fails to serve.
    const backupsDir = join(dataDir, "backups");
    const clientBackups = existsSync(backupsDir)
      ? (await import("node:fs")).readdirSync(backupsDir).filter((n: string) => n.startsWith("client-"))
      : [];
    expect(clientBackups.length).toBeGreaterThan(0);
    const backup = join(backupsDir, clientBackups[0] ?? "");
    // Tolerant to whether the backup captured the package root or the build dir.
    const backedUpIndex = [join(backup, "build", "index.html"), join(backup, "index.html")]
      .find((p) => existsSync(p));
    expect(backedUpIndex, "backup must contain the old index.html").toBeDefined();
    if (backedUpIndex) expect(readFileSync(backedUpIndex, "utf8")).toContain("old");
  });
});
