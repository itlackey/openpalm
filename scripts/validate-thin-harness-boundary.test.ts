// Regression coverage for scripts/validate-thin-harness-boundary.sh (design
// §6.1/§6.6, remediation plan 3.2).
//
// The guard's three sub-checks are exercised against FIXTURE files (not the
// real repo build) so the tests are fast, deterministic, and don't require a
// full `bun run --cwd packages/electron bundle` / `npm run build` round-trip.
// Paths are overridable via env vars so this is possible without touching the
// real repo tree — see the `THBOUNDARY_*` overrides read by the script.
//
// Covers two regressions fixed by 3.2:
//   (a) the bundle check used to grep for 2 hand-enumerated symbol names
//       (`performUpgrade`, `applyTagChange`) — one of which (`applyTagChange`)
//       no longer exists anywhere in the codebase, so it silently checked
//       nothing. It now checks the current stack-update entry point while the
//       source-import allowlist categorically blocks all other lifecycle APIs.
//   (b) the import-allowlist check used to read only `main.ts`'s FIRST
//       `@openpalm/lib` brace-import block, so `update-check.ts` and
//       `docker-preflight.ts` (which also import from `@openpalm/lib`) were
//       never validated. It now scans every `.ts` file under the src dir.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "validate-thin-harness-boundary.sh");

let dir: string;
let bundlePath: string;
let uiChunksDir: string;
let srcDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thboundary-"));
  bundlePath = join(dir, "main.js");
  uiChunksDir = join(dir, "ui-chunks");
  srcDir = join(dir, "src");
  mkdirSync(uiChunksDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  // (b) baseline: the control plane (UI build) DOES carry performUpgrade —
  // this is check (b) of the script and isn't what these tests exercise, so
  // always satisfy it.
  writeFileSync(join(uiChunksDir, "chunk.js"), "function performUpgrade() {}\n");
  // A clean main.ts that only imports allowlisted symbols.
  writeFileSync(
    join(srcDir, "main.ts"),
    "import { resolveOpenPalmHome, PLATFORM_VERSION } from '@openpalm/lib';\n" +
      "console.log(resolveOpenPalmHome, PLATFORM_VERSION);\n",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(bundleContent: string): { status: number | null; stderr: string; stdout: string } {
  writeFileSync(bundlePath, bundleContent);
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: {
      ...process.env,
      THBOUNDARY_MAIN_BUNDLE: bundlePath,
      THBOUNDARY_UI_CHUNKS_DIR: uiChunksDir,
      THBOUNDARY_ELECTRON_SRC_DIR: srcDir,
    },
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe("validate-thin-harness-boundary.sh — sentinel bundle check", () => {
  it("passes when the frozen bundle carries no mutation-engine sentinel", () => {
    const result = run("console.log('just some harness bootstrap code');\n");
    expect(result.status).toBe(0);
  });

  it("fails when the frozen bundle carries the stack-update entry point", () => {
    const result = run("function performUpgrade(){}\n");
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/performUpgrade/);
  });
});

describe("validate-thin-harness-boundary.sh — scans ALL electron/src files, not just main.ts", () => {
  it("fails when a SECONDARY file (not main.ts) imports a non-allowlisted @openpalm/lib symbol", () => {
    writeFileSync(
      join(srcDir, "update-check.ts"),
      "import { performUpgrade } from '@openpalm/lib';\nconsole.log(performUpgrade);\n",
    );
    const result = run("console.log('clean bundle');\n");
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/update-check\.ts/);
    expect(result.stderr + result.stdout).toMatch(/performUpgrade/);
  });

  it("passes when a secondary file imports only allowlisted symbols", () => {
    writeFileSync(
      join(srcDir, "docker-preflight.ts"),
      "import { checkDocker, checkDockerCompose } from '@openpalm/lib';\nconsole.log(checkDocker, checkDockerCompose);\n",
    );
    const result = run("console.log('clean bundle');\n");
    expect(result.status).toBe(0);
  });

  it("fails on a namespace import (`import * as lib from '@openpalm/lib'`) anywhere in the tree", () => {
    writeFileSync(
      join(srcDir, "sneaky.ts"),
      "import * as lib from '@openpalm/lib';\nconsole.log(lib);\n",
    );
    const result = run("console.log('clean bundle');\n");
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/sneaky\.ts/);
  });

  it("fails on a dynamic import() of '@openpalm/lib' anywhere in the tree", () => {
    writeFileSync(
      join(srcDir, "sneaky.ts"),
      "async function f() { const lib = await import('@openpalm/lib'); return lib; }\n",
    );
    const result = run("console.log('clean bundle');\n");
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/sneaky\.ts/);
  });

  it("fails on a require('@openpalm/lib') anywhere in the tree", () => {
    writeFileSync(
      join(srcDir, "sneaky.ts"),
      "const lib = require('@openpalm/lib');\nconsole.log(lib);\n",
    );
    const result = run("console.log('clean bundle');\n");
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/sneaky\.ts/);
  });
});
