/**
 * Install/Update integration-test HARNESS (Phase 0 of the install-update rebuild;
 * see docs/technical/install-update-rebuild-plan.md).
 *
 * Provides a disposable OP_HOME laid out in the four-tree ownership model
 * (system / config+knowledge+workspace / data / state) and a throwaway
 * `docker compose` project under a UNIQUE name (never the user's `openpalm`
 * project, never ~/.openpalm). Used by iu-invariants.integration.test.ts and,
 * as later phases land, by the real apply()/applyStack() integration checks.
 *
 * NOT a unit-test file (no `.test.ts` suffix) so the normal suite ignores it.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/** True when real `docker compose` integration assertions should be skipped. */
export const SKIP_DOCKER =
  !process.env.RUN_DOCKER_STACK_TESTS || process.env.CI === "true";

export const sha = (p: string): string =>
  createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);

export function write(p: string, c: string): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, c);
}

/** atomic temp+rename write (mirrors the copy-out transition contract, §1b). */
export function writeAtomic(p: string, c: string): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, c);
  renameSync(tmp, p);
}

export type Tree = "system" | "config" | "knowledge" | "workspace" | "data" | "state";

/**
 * A throwaway OP_HOME seeded with one representative file per ownership tree, so
 * an "overwrite system/" can be proven to leave every other tree byte-identical.
 */
export interface Home {
  dir: string;
  /** relative paths, grouped by owning tree */
  files: Record<Tree, string[]>;
  cleanup(): void;
}

export function makeHome(): Home {
  const dir = mkdtempSync(join(tmpdir(), "op-iu-home-"));
  const files: Record<Tree, string[]> = {
    // MANAGED — overwritten wholesale
    system: [
      "system/stack/core.compose.yml",
      "system/assistant/opencode.jsonc", // system OpenCode config (plugins/permissions)
      "system/skills/notify/SKILL.md", // built-in skill
      "system/assistant/tools/package.json", // tool manifest
    ],
    // USER — seeded once, then never touched
    config: ["config/assistant/opencode.json", "config/assistant/persona.md", "config/stack/custom.compose.yml"],
    knowledge: ["knowledge/secrets/auth.json", "knowledge/skills/my-own/SKILL.md"],
    workspace: ["workspace/notes.md"],
    // RUNTIME — never written by install/update
    data: ["data/assistant/state.db", "data/logs/app.log"],
    // STATE — app-written only
    state: ["state/stack.state.env"],
  };
  const seed: Record<string, string> = {
    "system/stack/core.compose.yml": "services:\n  a:\n    image: SYSTEM_V1\n",
    "system/assistant/opencode.jsonc": '{ "plugin": ["akm-opencode"], "permission": { "edit": "allow" } }\n',
    "system/skills/notify/SKILL.md": "# built-in notify v1\n",
    "system/assistant/tools/package.json": '{ "dependencies": { "opencode-ai": "^1.17.0" } }\n',
    "config/assistant/opencode.json": '{ "model": "USER/choice" }\n',
    "config/assistant/persona.md": "# my persona\n",
    "config/stack/custom.compose.yml": "services:\n  myextra:\n    image: mine\n",
    "knowledge/secrets/auth.json": '{ "token": "USER-PRIVATE-SECRET" }\n',
    "knowledge/skills/my-own/SKILL.md": "# user authored skill\n",
    "workspace/notes.md": "my notes\n",
    "data/assistant/state.db": "BINARY-DB-CONTENT\n",
    "data/logs/app.log": "log line\n",
    "state/stack.state.env": "OP_ASSISTANT_VERSION=0.11.0\nOP_ENABLED_ADDONS=discord\n",
  };
  for (const rels of Object.values(files)) for (const rel of rels) write(join(dir, rel), seed[rel]!);
  return {
    dir,
    files,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** sha of every file NOT in `system/` — the trees an overwrite must never alter. */
export function nonSystemDigests(home: Home): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tree, rels] of Object.entries(home.files)) {
    if (tree === "system") continue;
    for (const rel of rels) out[rel] = sha(join(home.dir, rel));
  }
  return out;
}

// ── throwaway docker compose ────────────────────────────────────────────────

export interface ComposeProject {
  project: string;
  file: string;
  dir: string;
  up(envFile: string): { ok: boolean; err: string };
  runningImage(service: string): { digest: string; tag: string } | null;
  pull(service: string, envFile: string): { ok: boolean; err: string };
  cleanup(): void;
}

function docker(args: string[]): { ok: boolean; out: string; err: string } {
  try {
    return { ok: true, out: execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), err: "" };
  } catch (e) {
    const err = e as { stdout?: { toString(): string }; stderr?: { toString(): string } };
    return { ok: false, out: err.stdout?.toString() ?? "", err: err.stderr?.toString() ?? String(e) };
  }
}

/** A compose project named uniquely (op-iu-<pid>-<n>) using a tiny local image. */
let projCounter = 0;
export function makeComposeProject(image = "alpine:3.19"): ComposeProject {
  const dir = mkdtempSync(join(tmpdir(), "op-iu-compose-"));
  const project = `op-iu-${process.pid}-${projCounter++}`;
  const file = join(dir, "compose.yml");
  writeFileSync(file, `services:\n  svc:\n    image: ${image.split(":")[0]}:\${SVC_TAG}\n    command: ["sleep", "120"]\n`);
  return {
    project,
    file,
    dir,
    up(envFile) {
      const r = docker(["compose", "-p", project, "-f", file, "--env-file", envFile, "up", "-d"]);
      return { ok: r.ok, err: r.err };
    },
    runningImage(service) {
      const id = docker(["compose", "-p", project, "-f", file, "ps", "-q", service]).out.trim();
      if (!id) return null;
      const digest = docker(["inspect", "--format", "{{.Image}}", id]).out.trim();
      const tag = docker(["inspect", "--format", "{{.Config.Image}}", id]).out.trim();
      return { digest, tag };
    },
    pull(service, envFile) {
      const r = docker(["compose", "-p", project, "-f", file, "--env-file", envFile, "pull", service]);
      return { ok: r.ok, err: r.err || r.out };
    },
    cleanup() {
      // -t 1: don't wait the default 10s grace per container during teardown.
      docker(["compose", "-p", project, "-f", file, "down", "-v", "--remove-orphans", "-t", "1"]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { existsSync, readFileSync, join };
