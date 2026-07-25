/**
 * Skeleton guardrail tests — validate packages/skeleton/ directory structure matches v0.11.0.
 *
 * packages/skeleton/ is the repo-shipped OP_HOME skeleton (the SOURCE the
 * runtime seeds OP_HOME from, resolveLocalOpenpalmDir -> packages/skeleton).
 * These tests prevent reintroduction of pre-v0.11.0 directories (stack/,
 * registry/, stash-seeds/) and ensure the v0.11.0 structure stays intact.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SKELETON_DIR = join(REPO_ROOT, "packages", "skeleton");

// Allowed top-level dirs in the skeleton — mirrors the OP_HOME runtime layout
const ALLOWED_SOURCE_DIRS = new Set([
  "config",     // seed files for config/ (assistant, guardian, stack/, akm/)
  "knowledge",      // knowledge source assets: skills/, env/, secrets/, tasks/
  "data",       // empty service dirs (.gitkeep)
  "workspace",  // empty workspace dir (.gitkeep)
  "system",     // managed tree: compose stack (system/stack)
]);

// ── Top-level structure ───────────────────────────────────────────────

describe("skeleton: top-level directories", () => {
  test("only allowed directories exist", () => {
    const entries = readdirSync(SKELETON_DIR);
    const dirs = entries.filter(e => {
      try { return statSync(join(SKELETON_DIR, e)).isDirectory(); } catch { return false; }
    });
    const unexpected = dirs.filter(d => !ALLOWED_SOURCE_DIRS.has(d));
    expect(unexpected).toEqual([]);
  });

  test("stack/ no longer exists (moved to system/stack/)", () => {
    expect(existsSync(join(SKELETON_DIR, "stack"))).toBe(false);
  });

  test("registry/ no longer exists", () => {
    expect(existsSync(join(SKELETON_DIR, "registry"))).toBe(false);
  });

  test("stash-seeds/ no longer exists (moved to knowledge/)", () => {
    expect(existsSync(join(SKELETON_DIR, "stash-seeds"))).toBe(false);
  });
});

// ── power-user helper scripts ─────────────────────────────────────────

describe("skeleton: helper scripts", () => {
  test("openpalm.sh and openpalm.ps1 ship at the skeleton root", () => {
    expect(existsSync(join(SKELETON_DIR, "openpalm.sh"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "openpalm.ps1"))).toBe(true);
  });
});

// ── config/ subdirectory ──────────────────────────────────────────────

describe("skeleton: config/ structure", () => {
  test("system/stack/ holds the MANAGED compose trio; custom.compose.yml is USER-owned in config/stack", () => {
    expect(existsSync(join(SKELETON_DIR, "system", "stack", "core.compose.yml"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "system", "stack", "services.compose.yml"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "system", "stack", "portals.compose.yml"))).toBe(true);
    // custom.compose.yml is user-editable → ships in the user tree, NOT system/stack.
    expect(existsSync(join(SKELETON_DIR, "config", "stack", "custom.compose.yml"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "system", "stack", "custom.compose.yml"))).toBe(false);
    // stack.yml removed in 0.11.0 — addon enablement lives in stack.env.
    expect(existsSync(join(SKELETON_DIR, "system", "stack", "stack.yml"))).toBe(false);
  });

  test("config/stack/addons/ does not exist", () => {
    expect(existsSync(join(SKELETON_DIR, "system", "stack", "addons"))).toBe(false);
  });

  test("voice compose fallback overlays ship as STATIC skeleton files (2.2 — no generators)", () => {
    // Materialized into every OP_HOME by applyHomeSeed (system/ is always
    // overwritten wholesale), same as core/services/portals.compose.yml. The
    // voice bring-up engine only decides whether to reference the file that's
    // already there — nothing generates these at runtime.
    const cdi = join(SKELETON_DIR, "system", "stack", "voice.compose.cdi.yml");
    const rootless = join(SKELETON_DIR, "system", "stack", "voice.compose.rootless.yml");
    expect(existsSync(cdi)).toBe(true);
    expect(existsSync(rootless)).toBe(true);
    expect(readFileSync(cdi, "utf-8")).toContain("voice-cuda:");
    expect(readFileSync(rootless, "utf-8")).toContain("user: null");
  });

  test("config/akm/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "config", "akm"))).toBe(true);
  });

  test("OpenCode config is split: MANAGED → system/, USER → config/ (four-tree)", () => {
    // MANAGED (OPENCODE_CONFIG_DIR): plugins/permissions/instructions in system/.
    expect(existsSync(join(SKELETON_DIR, "system", "assistant", "opencode.jsonc"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "system", "assistant", "instructions", "core.md"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "system", "guardian", "opencode.jsonc"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "system", "guardian", "instructions", "moderation.md"))).toBe(true);
    // USER (mounted at ~/.config/opencode): power-user model/persona in config/.
    expect(existsSync(join(SKELETON_DIR, "config", "assistant", "opencode.json"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "config", "assistant", "persona.md"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "config", "guardian", "opencode.json"))).toBe(true);
    // The managed config must NOT ship in the user tree.
    expect(existsSync(join(SKELETON_DIR, "config", "assistant", "opencode.jsonc"))).toBe(false);
    expect(existsSync(join(SKELETON_DIR, "config", "guardian", "opencode.jsonc"))).toBe(false);
  });

  test('stack compose assets use a per-image OP_*_VERSION pin (no OP_IMAGE_TAG cascade)', () => {
    const coreCompose = readFileSync(join(SKELETON_DIR, 'system', 'stack', 'core.compose.yml'), 'utf-8');
    const channelsCompose = readFileSync(join(SKELETON_DIR, 'system', 'stack', 'portals.compose.yml'), 'utf-8');

    expect(coreCompose).toContain('assistant:${OP_ASSISTANT_VERSION:-latest}');
    expect(channelsCompose).toContain('portal:${OP_PORTAL_VERSION:-latest}');
    expect(channelsCompose).toContain('guardian:${OP_GUARDIAN_VERSION:-latest}');
    // The old single-tag cascade must be gone.
    expect(coreCompose).not.toContain('OP_IMAGE_TAG');
    expect(channelsCompose).not.toContain('OP_IMAGE_TAG');
  });

  test('third-party addon images (ollama) are pinned by exact version + digest, never :latest', () => {
    // rev4-F1 (docs/reviews/fable-security-remediation-plan.md S.6): ollama sits
    // inside the trust boundary (assistant_net) with no upstream auth. An
    // unpinned :latest tag means a registry-side publish is a same-day
    // code-execution path into the assistant's network — pin by tag@digest.
    const servicesCompose = readFileSync(join(SKELETON_DIR, 'system', 'stack', 'services.compose.yml'), 'utf-8');

    expect(servicesCompose).not.toContain('ollama/ollama:latest');
    const pinnedOllamaImage = /image:\s*ollama\/ollama:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}/g;
    const matches = servicesCompose.match(pinnedOllamaImage) ?? [];
    // ollama, ollama-cuda, and ollama-rocm each declare their own pinned image.
    expect(matches.length).toBe(3);
  });

  test('every host-published listener uses a FLAT bind — no cascade', () => {
    // The retired `${OP_X_BIND:-${OP_BIND_ADDRESS:-127.0.0.1}}` nesting meant
    // "unset" inherited for four listeners and meant loopback for one, in the
    // same file. Every bind is now generated explicitly by the access toggles.
    const channelsCompose = readFileSync(join(SKELETON_DIR, 'system', 'stack', 'portals.compose.yml'), 'utf-8');
    const servicesCompose = readFileSync(join(SKELETON_DIR, 'system', 'stack', 'services.compose.yml'), 'utf-8');
    const coreCompose = readFileSync(join(SKELETON_DIR, 'system', 'stack', 'core.compose.yml'), 'utf-8');

    for (const compose of [channelsCompose, servicesCompose, coreCompose]) {
      expect(compose).not.toContain(':-${OP_BIND_ADDRESS');
    }

    expect(coreCompose).toContain('${OP_UI_BIND_ADDRESS:-127.0.0.1}:${OP_UI_PORT:-3800}:3000');
    expect(coreCompose).toContain('${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3810}:4096');
    expect(channelsCompose).toContain('${OP_GUARDIAN_BIND_ADDRESS:-127.0.0.1}:${OP_GUARDIAN_PORT:-3830}:3830');
    expect(channelsCompose).toContain('${OP_API_BIND_ADDRESS:-127.0.0.1}:${OP_API_PORT:-3821}:8182');

    // Voice serves an API reached through the UI's /voice proxy — it never
    // needs a host port, so its bind is a literal, not a knob.
    expect(servicesCompose).toContain('"127.0.0.1:${OP_VOICE_PORT_HOST:-8880}:8880"');
    expect(servicesCompose).not.toContain('OP_VOICE_BIND_ADDRESS');

    // One host port onto the guardian's OpenAI-compatible listener, not two.
    expect(channelsCompose).not.toContain('OP_CHAT_PORT');
    expect(channelsCompose).not.toContain('OP_CHAT_BIND_ADDRESS');

    expect(coreCompose).not.toContain('OP_ASSISTANT_SSH_PORT');
    expect(coreCompose).not.toContain('OP_ASSISTANT_SSH_BIND_ADDRESS');
  });

  test('no CORS grant survives — the browser reaches OpenCode same-origin', () => {
    const coreCompose = readFileSync(join(SKELETON_DIR, 'system', 'stack', 'core.compose.yml'), 'utf-8');
    expect(coreCompose).not.toContain('OP_UI_CORS_ALLOWED_ORIGINS');
    expect(coreCompose).not.toContain('OP_UI_DEFAULT_ASSISTANT_URL');
  });

  test('compose assets keep only consumed openpalm.profile labels', () => {
    const channelsCompose = readFileSync(join(SKELETON_DIR, 'system', 'stack', 'portals.compose.yml'), 'utf-8');
    const servicesCompose = readFileSync(join(SKELETON_DIR, 'system', 'stack', 'services.compose.yml'), 'utf-8');

    expect(channelsCompose).not.toContain('openpalm.name:');
    expect(channelsCompose).not.toContain('openpalm.description:');
    expect(channelsCompose).not.toContain('openpalm.icon:');
    expect(channelsCompose).not.toContain('openpalm.category:');
    expect(channelsCompose).not.toContain('openpalm.healthcheck:');
    expect(servicesCompose).not.toContain('openpalm.name:');
    expect(servicesCompose).not.toContain('openpalm.description:');
    expect(servicesCompose).not.toContain('openpalm.icon:');
    expect(servicesCompose).not.toContain('openpalm.category:');
    expect(servicesCompose).not.toContain('openpalm.healthcheck:');
    expect(servicesCompose).toContain('openpalm.profile.label:');
  });
});

// ── no runtime registry ───────────────────────────────────────────────

describe("skeleton: no runtime registry", () => {
  test("data/registry/ does not exist", () => {
    expect(existsSync(join(SKELETON_DIR, "data", "registry"))).toBe(false);
  });
});

// ── knowledge/ subdirectory ───────────────────────────────────────────────

describe("skeleton: knowledge/ structure", () => {
  test("knowledge/skills/ exists with config-diagnostics skill", () => {
    expect(existsSync(join(SKELETON_DIR, "knowledge", "skills", "config-diagnostics", "SKILL.md"))).toBe(true);
  });

  test("knowledge/env/ exists with user.env seed", () => {
    expect(existsSync(join(SKELETON_DIR, "knowledge", "env", "user.env"))).toBe(true);
  });

  test("knowledge/secrets/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "knowledge", "secrets"))).toBe(true);
  });

  test("knowledge/tasks/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "knowledge", "tasks"))).toBe(true);
  });
});

// ── data/ service dirs ────────────────────────────────────────────────

describe("skeleton: data/ service directories", () => {
  const serviceDirs = ["assistant", "guardian"];

  for (const dir of serviceDirs) {
    test(`data/${dir}/ exists`, () => {
      expect(existsSync(join(SKELETON_DIR, "data", dir))).toBe(true);
    });
  }

  test("data/akm/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "data", "akm"))).toBe(true);
  });

  test("data/akm/cache and data/akm/data exist", () => {
    expect(existsSync(join(SKELETON_DIR, "data", "akm", "cache"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "data", "akm", "data"))).toBe(true);
  });

  test("data/logs/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "data", "logs"))).toBe(true);
  });
});

// ── data/rollback and workspace/ ──────────────────────────────────────

describe("skeleton: data/rollback and workspace/", () => {
  test("cache/ does not exist in the skeleton", () => {
    expect(existsSync(join(SKELETON_DIR, "cache"))).toBe(false);
  });

  test("data/backups/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "data", "backups"))).toBe(true);
  });

  test("data/rollback/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "data", "rollback"))).toBe(true);
  });

  test("workspace/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "workspace"))).toBe(true);
  });
});
