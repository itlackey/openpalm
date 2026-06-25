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
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, cpSync } from "node:fs";
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

  test("INV5 [STUB Phase 3] getRunningImages() returns running digest+tag; stopped/absent stated", () => {
    throw new Error(
      "STUB — Phase 3: implement getRunningImages() in docker.ts (digest + tag + health; " +
        "stopped → 'current (stopped)'; absent → 'not installed'). Then assert it here against a live container.",
    );
  });

  test("INV6 [STUB Phase 1] config/assistant has NO node_modules after the OpenCode config split", () => {
    throw new Error(
      "STUB — Phase 1: wire OPENCODE_CONFIG_DIR→system/, OPENCODE_CONFIG=config/assistant/opencode.json " +
        "in containers/{assistant,guardian}; assert a booted assistant leaves config/assistant free of node_modules.",
    );
  });

  test("INV7 [STUB Phase 2] apply() overwrites system/, seeds user trees if-missing, is idempotent, never touches user/state", () => {
    throw new Error(
      "STUB — Phase 2: implement the unified apply() (overwriteSystemTree + seedUserDefaults). " +
        "Replace this body with: run apply() twice on a populated home; assert system updated, user/data/state byte-identical, 2nd run a no-op.",
    );
  });

  test("INV8 [STUB Phase 4] control-plane hot-swap + supervisor restart lands on the new build", () => {
    throw new Error(
      "STUB — Phase 4: implement npm hot-swap (UI build + skeleton) + supervisor restart. " +
        "Assert: resolve→verify integrity→stage→rename→stamp; restart lands on the new stamped build; bad integrity aborts to backup.",
    );
  });
});
