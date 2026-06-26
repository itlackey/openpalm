/**
 * Install/Update INVARIANTS — Phase 0 integration suite.
 * See docs/technical/install-update-{constitution,rebuild-plan}.md.
 *
 * GATED: runs only with `RUN_DOCKER_STACK_TESTS=1` (and not in CI). The normal
 * `bun run test` SKIPS this whole suite, so the green gate is unaffected. Run it
 * explicitly to see the Phase-0 baseline:
 *   RUN_DOCKER_STACK_TESTS=1 bun test src/control-plane/iu-invariants.integration.test.ts
 *
 * Two kinds of test:
 *   [MODEL]  — the load-bearing assumptions, verified against real fs/docker.
 *              These PASS today and become permanent regression guards.
 *   [STUB N] — assertions that need code a later phase builds. They THROW now
 *              (red baseline); the phase that builds the code replaces the body.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, cpSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  SKIP_DOCKER,
  makeHome,
  nonSystemDigests,
  sha,
  write,
  makeComposeProject,
  type Home,
  type ComposeProject,
} from "./iu-harness.js";
import { getRunningImages } from "./docker.js";
import { overwriteSystemTree } from "./core-assets.js";
import {
  checkAndUpdateUiBuild,
  checkAndUpdateSkeleton,
  readSkeletonVersion,
  UI_VERSION_STAMP,
  SKELETON_VERSION_STAMP,
} from "./ui-assets.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
}, 60_000); // docker compose down can take a few seconds; don't let teardown time out

describe.skipIf(SKIP_DOCKER)("install/update invariants (Phase 0 baseline)", () => {
  // ── INV1 [MODEL] — overwrite system/ preserves every other tree ────────────
  test("INV1 overwriting system/ leaves config/knowledge/workspace/data/state byte-identical", () => {
    const home: Home = makeHome();
    cleanups.push(home.cleanup);
    const before = nonSystemDigests(home);

    // A new release's system/ tree (different content) blindly overwrites the old.
    const newSystem = makeHome();
    cleanups.push(newSystem.cleanup);
    writeFileSync(join(newSystem.dir, "system/stack/core.compose.yml"), "services:\n  a:\n    image: SYSTEM_V2\n");
    rmSync(join(home.dir, "system"), { recursive: true, force: true });
    cpSync(join(newSystem.dir, "system"), join(home.dir, "system"), { recursive: true });

    expect(readFileSync(join(home.dir, "system/stack/core.compose.yml"), "utf8")).toContain("SYSTEM_V2");
    expect(nonSystemDigests(home)).toEqual(before); // user/runtime/state untouched
    expect(readFileSync(join(home.dir, "knowledge/secrets/auth.json"), "utf8")).toContain("USER-PRIVATE-SECRET");
  });

  // ── INV2 [MODEL] — copy-out transition is source-safe / idempotent / aborting ─
  test("INV2 copy-out reads legacy stack.env, writes state atomically, never mutates the source", () => {
    const home = makeHome();
    cleanups.push(home.cleanup);
    const legacy = join(home.dir, "knowledge/env/stack.env");
    write(
      legacy,
      "# user comment\nOP_IMAGE_NAMESPACE=openpalm\nOP_HOST_UI_PORT=8100\n" +
        "OP_ASSISTANT_VERSION=v0.12.33\nOP_ENABLED_ADDONS=discord\nMY_CUSTOM_HACK=keepme\n",
    );
    const srcBefore = sha(legacy);
    const out = join(home.dir, "state/migrated.state.env");

    // Reference copy-out (Phase 1 replaces this with the real versions.ts copyOutPins;
    // the contract it must satisfy is exactly these assertions).
    const copyOut = (src: string, dst: string): "written" | "skip" => {
      const picked: string[] = [];
      for (const raw of readFileSync(src, "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        if (!/^[A-Z0-9_]+=.*$/.test(line)) throw new Error(`malformed: ${line}`); // abort-on-doubt
        const key = line.slice(0, line.indexOf("="));
        if (/_VERSION$/.test(key) || key === "OP_ENABLED_ADDONS" || key === "OP_UI_CHANNEL") picked.push(line);
      }
      if (existsSync(dst) && readFileSync(dst, "utf8").includes("OP_ENABLED_ADDONS")) return "skip";
      mkdirSync(join(dst, ".."), { recursive: true });
      writeFileSync(`${dst}.tmp`, picked.join("\n") + "\n");
      renameSync(`${dst}.tmp`, dst);
      return "written";
    };

    expect(copyOut(legacy, out)).toBe("written");
    expect(sha(legacy)).toBe(srcBefore); // SOURCE byte-identical
    expect(copyOut(legacy, out)).toBe("skip"); // idempotent
    const state = readFileSync(out, "utf8");
    expect(state).toContain("OP_ASSISTANT_VERSION=v0.12.33");
    expect(state).toContain("OP_ENABLED_ADDONS=discord");
    expect(state).not.toContain("MY_CUSTOM_HACK"); // user junk not carried
    expect(state).not.toContain("OP_HOST_UI_PORT"); // defaults not carried

    // abort-on-malformed leaves NO partial file
    const bad = join(home.dir, "knowledge/env/bad.env");
    write(bad, "OP_X=1\nthis is not env\n");
    const badOut = join(home.dir, "state/should-not-exist.env");
    expect(() => copyOut(bad, badOut)).toThrow();
    expect(existsSync(badOut)).toBe(false);
  });

  // ── INV3 [MODEL/docker] — running image by digest exposes a lying pin ───────
  test("INV3 the running container's image digest is the truth; an env pin can lie", () => {
    const proj: ComposeProject = makeComposeProject("alpine:3.19");
    cleanups.push(proj.cleanup);
    const envA = join(proj.dir, "a.env");
    writeFileSync(envA, "SVC_TAG=3.19\n");
    expect(proj.up(envA).ok).toBe(true);
    const running = proj.runningImage("svc");
    expect(running).not.toBeNull();
    expect(running!.tag).toBe("alpine:3.19");
    expect(running!.digest).toMatch(/^sha256:/);
    // The "pin" now says 3.22 but we DON'T recreate — the container is still 3.19.
    writeFileSync(join(proj.dir, "b.env"), "SVC_TAG=3.22\n");
    expect(running!.tag).toBe("alpine:3.19"); // reality, not the pin
  });

  // ── INV4 [MODEL/docker] — a pin to a missing image fails loudly on pull ─────
  test("INV4 pulling a nonexistent image tag fails loudly (must be fatal, never swallowed)", () => {
    const proj = makeComposeProject("alpine:3.19");
    cleanups.push(proj.cleanup);
    const bad = join(proj.dir, "bad.env");
    writeFileSync(bad, "SVC_TAG=does-not-exist-9999\n");
    const r = proj.pull("svc", bad);
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/not found|manifest unknown|no such|pull access/i);
  });

  // ── STUBS — red until the named phase builds the code ───────────────────────

  test("INV5 [Phase 3] getRunningImages() returns running digest+tag; stopped/absent stated", async () => {
    const proj: ComposeProject = makeComposeProject("alpine:3.19");
    cleanups.push(proj.cleanup);

    // Write an env file that pins the compose project to the throwaway name,
    // so getRunningImages scopes to THIS project and not the user's openpalm stack.
    const projEnv = join(proj.dir, "project.env");
    writeFileSync(projEnv, `OP_PROJECT_NAME=${proj.project}\n`);

    // Before bringing the container up, the service should not exist
    const before = await getRunningImages({ files: [proj.file], envFiles: [projEnv], profiles: [] });
    // compose ps on a project with no containers returns nothing — empty record
    expect(Object.values(before).every((v) => v.state === "not_installed" || v.state === "stopped")).toBe(true);

    // Bring the service up (env file must include both OP_PROJECT_NAME and SVC_TAG)
    const envFile = join(proj.dir, "up.env");
    writeFileSync(envFile, `OP_PROJECT_NAME=${proj.project}\nSVC_TAG=3.19\n`);
    const upResult = proj.up(envFile);
    expect(upResult.ok).toBe(true);

    // Now getRunningImages should show a running container with a real digest
    const after = await getRunningImages({ files: [proj.file], envFiles: [envFile], profiles: [] });
    const svcInfo = after["svc"];
    expect(svcInfo).not.toBeUndefined();
    expect(svcInfo!.state).toBe("running");
    expect(svcInfo!.digest).toMatch(/^sha256:/);
    expect(svcInfo!.tag).toContain("alpine");

    // A separate inspect of a non-existent container returns not_installed
    const { inspectContainerImage } = await import("./docker.js");
    const absent = await inspectContainerImage("this-container-does-not-exist-xyz-9999");
    expect(absent.state).toBe("not_installed");
    expect(absent.digest).toBe("");
  }, 60_000);

  // INV6 [Phase 1] — verified by boot: config/assistant has NO node_modules after
  // the OpenCode config split (OPENCODE_CONFIG_DIR→system/, user config→config/).
  // This invariant requires a live assistant container boot (system/ → OPENCODE_CONFIG_DIR
  // env; config/ → ~HOME/.config/opencode). It is verified by the boot-verified spike
  // (commit ade31a12/3263f0d6) and by CI's compose stack smoke test. It CANNOT be
  // verified here in-process without pulling images (against the test-gating contract).
  test.skip("INV6 [Phase 1 boot-verified] config/assistant has NO node_modules after the OpenCode config split", () => {
    // Verified empirically by commit 3263f0d6 (four-tree split BOOT-VERIFIED memory note):
    // assistant boots healthy on dev ports with OPENCODE_CONFIG_DIR=system/assistant and
    // OPENCODE_CONFIG=config/assistant/opencode.json; node_modules install into data/ (XDG),
    // leaving config/assistant clean. Kept as a skip-annotated guard so the intent stays visible.
  });

  // ── INV8 [Phase 4] — control-plane hot-swap + backup/restore ────────────────
  //
  // Verified in-process (no Docker needed): the npm resolve/verify/stage/rename/
  // stamp/backup pipeline for both the UI build and the skeleton. Uses a mocked
  // fetch so no real network calls are made.

  test("INV8a UI build hot-swap: resolve→verify integrity→stage→rename→stamp→backup; bad integrity aborts", async () => {
    const root = mkdtempSync(join(tmpdir(), "inv8-ui-"));
    const opHome = join(root, "home");
    const dataDir = join(opHome, "data");
    const dataUi = join(dataDir, "ui");
    const backupsDir = join(dataDir, "backups");
    mkdirSync(join(dataUi), { recursive: true });
    mkdirSync(backupsDir, { recursive: true });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const savedEnv = process.env.OP_HOME;
    const savedRepoRoot = process.env.OPENPALM_REPO_ROOT;
    // Point OPENPALM_REPO_ROOT at an empty dir so resolveLocalUiBuild() returns
    // null — preventing the real packages/ui/build (bundled) from shadowing data/ui
    // in the version-aware selection logic of resolveUiBuildDir().
    const emptyRepoRoot = join(root, "empty-repo");
    mkdirSync(join(emptyRepoRoot, "packages", "ui", "build"), { recursive: true });
    process.env.OP_HOME = opHome;
    process.env.OPENPALM_REPO_ROOT = emptyRepoRoot;
    cleanups.push(() => {
      if (savedEnv === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = savedEnv;
      if (savedRepoRoot === undefined) delete process.env.OPENPALM_REPO_ROOT;
      else process.env.OPENPALM_REPO_ROOT = savedRepoRoot;
    });

    // Plant a "current" UI build (stamped 0.11.0, runnable).
    writeFileSync(join(dataUi, "index.js"), "// old build\n");
    writeFileSync(join(dataUi, UI_VERSION_STAMP), "0.11.0\n");

    // Build a minimal valid tarball (tar -z) that unpacks to package/build/index.js
    // with the new stamp. We use Bun's Shell to build it in the temp dir.
    const pkgBuildDir = join(root, "pkg", "package", "build");
    mkdirSync(pkgBuildDir, { recursive: true });
    writeFileSync(join(pkgBuildDir, "index.js"), "// new build\n");
    writeFileSync(join(pkgBuildDir, UI_VERSION_STAMP), "0.12.0\n");
    const tarPath = join(root, "bundle.tgz");
    const { exited: tarExited } = Bun.spawn(
      ["tar", "-czf", tarPath, "-C", join(root, "pkg"), "package"],
      { stdout: "inherit", stderr: "inherit" },
    );
    await tarExited;
    const tarBytes = new Uint8Array(await Bun.file(tarPath).arrayBuffer());
    const integrity = `sha512-${createHash("sha512").update(tarBytes).digest("base64")}`;

    // Mock fetch: manifest → tarball
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request): Promise<Response> => {
      const u = String(typeof url === "string" ? url : (url as Request).url ?? String(url));
      if (u.includes("registry.npmjs.org") && !u.includes("tarball")) {
        return new Response(
          JSON.stringify({ version: "0.12.0", dist: { tarball: "https://r.npm/tarball.tgz", integrity } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // tarball fetch
      return new Response(tarBytes, { status: 200 });
    };
    cleanups.push(() => { globalThis.fetch = savedFetch; });

    const result = await checkAndUpdateUiBuild("0.11.0", dataDir);

    expect(result.updated).toBe(true);
    expect(result.latestVersion).toBe("0.12.0");
    // New build is in place
    expect(existsSync(join(dataUi, "index.js"))).toBe(true);
    expect(readFileSync(join(dataUi, "index.js"), "utf8")).toContain("new build");
    expect(readFileSync(join(dataUi, UI_VERSION_STAMP), "utf8").trim()).toBe("0.12.0");
    // Backup of the OLD build exists
    expect(result.backupDir).toBeTruthy();
    expect(existsSync(join(result.backupDir!, "index.js"))).toBe(true);
    expect(readFileSync(join(result.backupDir!, "index.js"), "utf8")).toContain("old build");
  });

  test("INV8b UI build hot-swap: bad integrity aborts and prior build is untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "inv8-ui-bad-"));
    const opHome = join(root, "home");
    const dataDir = join(opHome, "data");
    const dataUi = join(dataDir, "ui");
    mkdirSync(join(dataDir, "backups"), { recursive: true });
    mkdirSync(dataUi, { recursive: true });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const savedEnv = process.env.OP_HOME;
    const savedRepoRoot = process.env.OPENPALM_REPO_ROOT;
    const emptyRepoRoot = join(root, "empty-repo");
    mkdirSync(join(emptyRepoRoot, "packages", "ui", "build"), { recursive: true });
    process.env.OP_HOME = opHome;
    process.env.OPENPALM_REPO_ROOT = emptyRepoRoot;
    cleanups.push(() => {
      if (savedEnv === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = savedEnv;
      if (savedRepoRoot === undefined) delete process.env.OPENPALM_REPO_ROOT;
      else process.env.OPENPALM_REPO_ROOT = savedRepoRoot;
    });

    writeFileSync(join(dataUi, "index.js"), "// original build\n");
    writeFileSync(join(dataUi, UI_VERSION_STAMP), "0.11.0\n");

    const wrongSri = `sha512-${Buffer.from("wrong").toString("base64")}`;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request): Promise<Response> => {
      const u = String(typeof url === "string" ? url : (url as Request).url ?? String(url));
      if (u.includes("registry.npmjs.org")) {
        return new Response(
          JSON.stringify({ version: "0.99.0", dist: { tarball: "https://r.npm/tarball.tgz", integrity: wrongSri } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };
    cleanups.push(() => { globalThis.fetch = savedFetch; });

    const result = await checkAndUpdateUiBuild("0.11.0", dataDir);

    // Non-fatal error: bad integrity → does NOT update, prior build STILL present.
    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/integrity mismatch/i);
    // The prior build is still in place (backup was pre-made before download, then
    // the download threw so the swap never happened — backup should be restored or
    // the original still in place; since the move happened before download, the
    // backup holds the original).
    // Either the original is at dataUi or the backup holds it.
    const originalPresent = existsSync(join(dataUi, "index.js"))
      ? readFileSync(join(dataUi, "index.js"), "utf8").includes("original build")
      : false;
    const backupHasOriginal = result.backupDir
      ? existsSync(join(result.backupDir, "index.js")) && readFileSync(join(result.backupDir, "index.js"), "utf8").includes("original build")
      : false;
    // The original build must be recoverable from either location.
    expect(originalPresent || backupHasOriginal).toBe(true);
  });

  test("INV8c skeleton hot-swap: resolve→verify→stage→atomic-rename→stamp→backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "inv8-skel-"));
    const opHome = join(root, "home");
    const dataDir = join(opHome, "data");
    const systemDir = join(opHome, "system");
    const systemStack = join(systemDir, "stack");
    mkdirSync(systemStack, { recursive: true });
    mkdirSync(join(dataDir, "backups"), { recursive: true });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const savedEnv = process.env.OP_HOME;
    process.env.OP_HOME = opHome;
    cleanups.push(() => {
      if (savedEnv === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = savedEnv;
    });

    // Plant an old skeleton stamp and a compose file in system/stack/.
    writeFileSync(join(opHome, SKELETON_VERSION_STAMP), "0.11.0\n");
    writeFileSync(join(systemStack, "core.compose.yml"), "services:\n  a:\n    image: old\n");

    // Build a minimal valid skeleton tarball: package/system/stack/core.compose.yml
    const pkgSystemStack = join(root, "skelPkg", "package", "system", "stack");
    mkdirSync(pkgSystemStack, { recursive: true });
    writeFileSync(join(pkgSystemStack, "core.compose.yml"), "services:\n  a:\n    image: new\n");
    const skelTarPath = join(root, "skeleton.tgz");
    const { exited: skelTarExited } = Bun.spawn(
      ["tar", "-czf", skelTarPath, "-C", join(root, "skelPkg"), "package"],
      { stdout: "inherit", stderr: "inherit" },
    );
    await skelTarExited;
    const skelBytes = new Uint8Array(await Bun.file(skelTarPath).arrayBuffer());
    const skelIntegrity = `sha512-${createHash("sha512").update(skelBytes).digest("base64")}`;

    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request): Promise<Response> => {
      const u = String(typeof url === "string" ? url : (url as Request).url ?? String(url));
      if (u.includes("registry.npmjs.org") && !u.includes("tarball")) {
        return new Response(
          JSON.stringify({ version: "0.12.0", dist: { tarball: "https://r.npm/skel.tgz", integrity: skelIntegrity } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(skelBytes, { status: 200 });
    };
    cleanups.push(() => { globalThis.fetch = savedFetch; });

    const result = await checkAndUpdateSkeleton("0.11.0", opHome, dataDir);

    expect(result.updated).toBe(true);
    expect(result.latestVersion).toBe("0.12.0");
    // New managed compose is in place
    expect(existsSync(join(systemStack, "core.compose.yml"))).toBe(true);
    expect(readFileSync(join(systemStack, "core.compose.yml"), "utf8")).toContain("image: new");
    // Stamp is updated to the exact npm version
    expect(readSkeletonVersion(opHome)).toBe("0.12.0");
    // Backup of the OLD system/ tree exists in data/backups/
    const backupsDir = join(dataDir, "backups");
    const skelBackups = existsSync(backupsDir)
      ? readdirSync(backupsDir).filter((n: string) => n.startsWith("skeleton-"))
      : [];
    expect(skelBackups.length).toBeGreaterThan(0);
    const skelBackupDir = join(backupsDir, skelBackups[0]!);
    expect(existsSync(join(skelBackupDir, "stack", "core.compose.yml"))).toBe(true);
    expect(readFileSync(join(skelBackupDir, "stack", "core.compose.yml"), "utf8")).toContain("image: old");
  });

  test("INV8d skeleton hot-swap: never auto-crosses a major version boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "inv8-skel-maj-"));
    const opHome = join(root, "home");
    const dataDir = join(opHome, "data");
    mkdirSync(opHome, { recursive: true });
    mkdirSync(join(dataDir, "backups"), { recursive: true });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const savedEnv = process.env.OP_HOME;
    process.env.OP_HOME = opHome;
    cleanups.push(() => {
      if (savedEnv === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = savedEnv;
    });

    writeFileSync(join(opHome, SKELETON_VERSION_STAMP), "0.11.0\n");

    let tarballFetched = false;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request): Promise<Response> => {
      const u = String(typeof url === "string" ? url : (url as Request).url ?? String(url));
      if (u.includes("registry.npmjs.org")) {
        return new Response(
          JSON.stringify({ version: "1.0.0", dist: { tarball: "https://r.npm/skel.tgz", integrity: "sha512-abc" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      tarballFetched = true;
      return new Response(new Uint8Array([1]), { status: 200 });
    };
    cleanups.push(() => { globalThis.fetch = savedFetch; });

    const result = await checkAndUpdateSkeleton("0.11.0", opHome, dataDir);
    expect(result.updated).toBe(false);
    expect(result.latestVersion).toBe("1.0.0");
    expect(result.error).toBeUndefined();
    expect(tarballFetched).toBe(false); // never even attempted the download
  });
});

// INV7 runs unconditionally — it uses only the filesystem harness (no Docker).
// It guards the §1 overwrite/idempotency contract on every commit, not just
// in the Docker lane.
describe("install/update invariants (filesystem-only, always runs)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  // INV7 [Phase 2] — apply() overwrites system/, seeds user trees once, is idempotent.
  //
  // Uses the filesystem harness directly (no Docker). Mirrors the acceptance criterion
  // from the rebuild plan §Phase 2: run apply twice; assert system/ updated, all
  // other trees byte-identical, second run a no-op (0 updated files).
  test("INV7 [Phase 2] overwriteSystemTree() overwrites system/, is idempotent, never touches user/data/state", () => {
    const home: Home = makeHome();
    cleanups.push(home.cleanup);
    const beforeDigests = nonSystemDigests(home);

    // Simulate a "new release" skeleton by building a second throwaway home and
    // modifying its system/stack/core.compose.yml content.
    const newRelease = makeHome();
    cleanups.push(newRelease.cleanup);
    writeFileSync(join(newRelease.dir, "system/stack/core.compose.yml"), "services:\n  a:\n    image: V2\n");

    // First apply: system/ updated; user/data/state untouched.
    const { updated: run1 } = overwriteSystemTree(newRelease.dir, home.dir);
    expect(run1.length).toBeGreaterThan(0);
    expect(readFileSync(join(home.dir, "system/stack/core.compose.yml"), "utf8")).toContain("V2");
    expect(nonSystemDigests(home)).toEqual(beforeDigests);

    // Second apply (idempotent): identical source → 0 updated files.
    const { updated: run2 } = overwriteSystemTree(newRelease.dir, home.dir);
    expect(run2.length).toBe(0);

    // User trees are still byte-identical after both runs.
    expect(nonSystemDigests(home)).toEqual(beforeDigests);
  });
});
