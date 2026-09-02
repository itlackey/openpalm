/**
 * #655.1 boundary guard — `dockerBin()` plus `run()` (docker.ts's own captured
 * execFile wrapper — deep-imported by consumers exactly the way the
 * volume-ownership repair subsystem already reuses it, per its docstring in
 * docker.ts) are the only sanctioned way to spawn `docker`. Before this fix,
 * FOUR separate call sites bypassed both and hardcoded the literal `"docker"`
 * as a spawn/exec argv[0] — `Bun.which('docker')`/`Bun.spawn(['docker', …])`
 * in the CLI's host-info.ts, and three `execFile`/`execFileNoThrow("docker",
 * …)` call sites across the UI — so `OP_DOCKER_BIN` (e.g. a podman shim)
 * silently had no effect on them.
 *
 * This test greps every non-test `.ts`/`.svelte` source file under
 * packages/{lib,cli,ui}/src for `"docker"`/`'docker'` used as a spawn/exec
 * argv[0], outside docker.ts itself (the one file allowed to define the
 * "docker" fallback `dockerBin()` returns), and fails if it finds one — so
 * a future raw call site can't reintroduce the seventh spawn path #655
 * removed the first six of.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

// The one file allowed to reference the literal "docker" as a spawn target —
// it's where dockerBin()'s "docker" fallback and run()'s execFile call live.
const DOCKER_TS = join("packages", "lib", "src", "control-plane", "docker.ts");

/**
 * Matches `execFile(`, `execFileSync(`, `execFileNoThrow(`, `spawn(`, or
 * `spawnSync(` immediately followed by the literal `"docker"`/`'docker'` —
 * across a possible line break, since every real offender in this codebase
 * wrapped its args onto the next line (e.g. `execFile(\n  "docker",`).
 */
const NODE_SPAWN_LITERAL_DOCKER_RE = /\b(?:execFile\w*|spawnSync|spawn)\s*\(\s*(?:\r?\n\s*)?["']docker["']/;

/** `Bun.spawn(['docker', …])` / `Bun.spawnSync(['docker', …])`. */
const BUN_SPAWN_LITERAL_DOCKER_RE =
  /Bun\.(?:spawn|spawnSync)\s*\(\s*(?:\r?\n\s*)?\[\s*(?:\r?\n\s*)?["']docker["']/;

/** `Bun.which('docker')` — resolving the literal instead of dockerBin(). */
const BUN_WHICH_LITERAL_DOCKER_RE = /Bun\.which\s*\(\s*["']docker["']/;

/**
 * Strip `//` and `/* *\/` comments so prose ABOUT the forbidden pattern (e.g.
 * "instead of a raw execFile('docker', …) call") doesn't itself trip the
 * detector — this test greps for real spawn/exec call sites, not mentions of
 * them. Deliberately simple (no string-literal awareness): the offenders this
 * guards against never hide inside a comment containing an unrelated "//" or
 * "/*", so the small imprecision that trades away is not a real risk here.
 */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function findViolations(filePath: string): string[] {
  const content = stripComments(readFileSync(filePath, "utf-8"));
  const violations: string[] = [];
  if (NODE_SPAWN_LITERAL_DOCKER_RE.test(content)) {
    violations.push("execFile/spawn(\"docker\", …) — route through dockerBin() + run()/execFileNoThrow() instead");
  }
  if (BUN_SPAWN_LITERAL_DOCKER_RE.test(content)) {
    violations.push("Bun.spawn(['docker', …]) — route through dockerBin() instead");
  }
  if (BUN_WHICH_LITERAL_DOCKER_RE.test(content)) {
    violations.push("Bun.which('docker') — route through dockerBin() instead");
  }
  return violations;
}

function listSourceFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true }) as Array<
    import("node:fs").Dirent & { parentPath?: string; path?: string }
  >;
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|svelte)$/.test(entry.name)) continue;
    // Test files may legitimately construct fixture strings/fake docker
    // shims that happen to contain these patterns (as this very file does) —
    // they are not production spawn sites.
    if (/\.(test|vitest)\.ts$/.test(entry.name)) continue;
    const parent = entry.parentPath ?? entry.path;
    if (!parent) continue;
    files.push(join(parent, entry.name));
  }
  return files;
}

describe("no raw \"docker\" spawn/exec argv[0] outside docker.ts (#655.1)", () => {
  it("packages/lib/src, packages/cli/src, and packages/ui/src route every docker invocation through dockerBin()", () => {
    const failures: string[] = [];
    for (const pkg of ["lib", "cli", "ui"]) {
      const srcDir = join(REPO_ROOT, "packages", pkg, "src");
      for (const file of listSourceFiles(srcDir)) {
        const relPath = relative(REPO_ROOT, file);
        if (relPath === DOCKER_TS) continue;
        for (const violation of findViolations(file)) {
          failures.push(`${relPath}: ${violation}`);
        }
      }
    }

    const message =
      `Raw "docker" spawn/exec argv[0] found outside docker.ts:\n${failures.join("\n")}\n\n` +
      `dockerBin() (packages/lib/src/control-plane/docker.ts) resolves the configured engine binary ` +
      `(OP_DOCKER_BIN, defaulting to "docker") — every spawn/exec site must go through it, either via ` +
      `docker.ts's own run() (deep-imported: import { run } from "@openpalm/lib/control-plane/docker.js") ` +
      `or execFileNoThrow(dockerBin(), …) (the sanctioned captured wrapper already used across the lib). ` +
      `A hardcoded "docker" literal silently ignores OP_DOCKER_BIN.`;
    expect(failures, message).toEqual([]);
  });

  // Self-test: prove the detector actually catches every historical offender
  // shape, so this guard cannot regress into matching nothing.
  it("detector recognizes every historical offender shape", () => {
    const offenders = [
      // packages/cli/src/lib/host-info.ts (pre-fix)
      "const dockerAvailable = Boolean(Bun.which('docker'));",
      "const proc = Bun.spawn(['docker', 'info'], { stdout: 'ignore' });",
      // packages/ui/src/routes/api/setup/system-check/+server.ts (pre-fix)
      'execFile(\n  "docker",\n  ["ps"],\n  {},\n  () => {},\n);',
      // packages/ui/src/routes/guardian/health/+server.ts (pre-fix)
      'await execFileAsync(\n  "docker",\n  ["container", "ls"],\n  {},\n);',
      // packages/ui/src/lib/server/voice/bring-up.ts (pre-fix)
      "const res = await execFileNoThrow('docker', ['image', 'inspect', imageRef], 5_000);",
    ];
    for (const offender of offenders) {
      const matched =
        NODE_SPAWN_LITERAL_DOCKER_RE.test(offender) ||
        BUN_SPAWN_LITERAL_DOCKER_RE.test(offender) ||
        BUN_WHICH_LITERAL_DOCKER_RE.test(offender);
      expect(matched, `expected a violation match for: ${offender}`).toBe(true);
    }
  });

  // And prove it does NOT flag the sanctioned patterns that replaced them.
  it("detector does not flag dockerBin()-routed calls", () => {
    const sanctioned = [
      "const dockerAvailable = dockerBinAvailable(dockerBin());",
      "const proc = Bun.spawn([dockerBin(), 'info'], { stdout: 'ignore' });",
      'const result = await runDocker(["ps"], undefined, 5_000);',
      "const res = await execFileNoThrow(dockerBin(), ['image', 'inspect', imageRef], 5_000);",
      // dockerBin()'s own fallback literal, inside docker.ts, is exempted by
      // PATH — not by pattern — but should also not match the spawn shapes.
      'return process.env.OP_DOCKER_BIN?.trim() || "docker";',
    ];
    for (const line of sanctioned) {
      const matched =
        NODE_SPAWN_LITERAL_DOCKER_RE.test(line) ||
        BUN_SPAWN_LITERAL_DOCKER_RE.test(line) ||
        BUN_WHICH_LITERAL_DOCKER_RE.test(line);
      expect(matched, `expected no violation match for: ${line}`).toBe(false);
    }
  });
});
