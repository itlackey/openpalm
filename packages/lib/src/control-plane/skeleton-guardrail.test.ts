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
import { join, relative, resolve } from "node:path";
import { VERSION_DEFAULTS } from "./versions.js";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SKELETON_DIR = join(REPO_ROOT, "packages", "skeleton");

// Allowed top-level dirs in the skeleton — mirrors the OP_HOME runtime layout
const ALLOWED_SOURCE_DIRS = new Set([
  "config",     // seed files for config/ (assistant, guardian, stack/, akm/)
  "knowledge",      // knowledge source assets: env/, secrets/, tasks/
  "data",       // empty service dirs (.gitkeep)
  "workspace",  // empty workspace dir (.gitkeep)
  "system",     // managed tree: compose stack (system/stack) + skills (system/skills)
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
    expect(readFileSync(rootless, "utf-8")).toContain('user: ""');
  });

  test("voice LAN-access overlay ships as a STATIC skeleton file, same as the CDI/rootless fallbacks", () => {
    // Unlike the CDI/rootless overlays (selected only by the voice bring-up
    // engine's one-off applyStack call), this one is also read by
    // discoverStackOverlays — see config-persistence.ts — so it must be
    // materialized into every OP_HOME the same way core/services/portals are.
    const lan = join(SKELETON_DIR, "system", "stack", "voice.compose.lan.yml");
    expect(existsSync(lan)).toBe(true);
    const content = readFileSync(lan, "utf-8");
    for (const svc of ["voice", "voice-cuda", "voice-rocm"]) {
      expect(content).toContain(`  ${svc}:`);
    }
    expect(content).toContain("assistant_net");
  });

  test("config/akm/ exists", () => {
    expect(existsSync(join(SKELETON_DIR, "config", "akm"))).toBe(true);
  });

  test("Paperclip user config and isolated AKM directories exist", () => {
    expect(existsSync(join(SKELETON_DIR, "config", "paperclip", "opencode", "opencode.json"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "system", "paperclip", "opencode.json"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "config", "paperclip", "akm"))).toBe(true);
    // Paperclip shares the assistant's stash as-is: no per-service overlay
    // dirs, because the /stash/{env,secrets} overmounts they backed are gone.
    expect(existsSync(join(SKELETON_DIR, "knowledge", "paperclip"))).toBe(false);
    expect(existsSync(join(SKELETON_DIR, "data", "paperclip-akm", "cache"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "data", "paperclip-akm", "data"))).toBe(true);
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

    expect(coreCompose).toContain('assistant:${OP_ASSISTANT_VERSION:?OP_ASSISTANT_VERSION is required}');
    expect(channelsCompose).toContain('portal:${OP_PORTAL_VERSION:?OP_PORTAL_VERSION is required}');
    expect(channelsCompose).toContain('guardian:${OP_GUARDIAN_VERSION:?OP_GUARDIAN_VERSION is required}');
    // The old single-tag cascade must be gone.
    expect(coreCompose).not.toContain('OP_IMAGE_TAG');
    expect(channelsCompose).not.toContain('OP_IMAGE_TAG');
  });

  test('third-party addon images (ollama) are pinned by exact version + digest, never :latest', () => {
    // rev4-F1: ollama sits
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

  test('K2: voice is the one image that intentionally floats — but its compose fallback and its code-level default can never silently disagree', () => {
    // Unlike Ollama (bundled third-party, exact-tag+digest pinned above) and
    // assistant/guardian/portal (platform semver, pinned to PLATFORM_VERSION —
    // see the OP_IMAGE_TAG test above), voice ships on its own out-of-band
    // release cadence (publish-voice.yml) with a variant-suffixed tag scheme
    // (`latest-cpu`, `1.0.0-cu121`, …) that has no platform-semver equivalent
    // to pin to. Tracking the moving `latest-<variant>` alias by default is a
    // deliberate, documented product decision (setup.ts, addon-availability.ts),
    // not an oversight — but the fallback compose reads and the code-level
    // default (versions.ts's VERSION_DEFAULTS, what a fresh stack.env is
    // seeded with) are two independently-edited literals, and only this test
    // notices if a future edit moves one without the other.
    const servicesCompose = readFileSync(join(SKELETON_DIR, 'system', 'stack', 'services.compose.yml'), 'utf-8');
    const composeFallback = `voice:\${OP_VOICE_VERSION:-${VERSION_DEFAULTS.OP_VOICE_VERSION}}-`;
    for (const variant of ['cpu', 'cu121', 'rocm6']) {
      expect(servicesCompose).toContain(`${composeFallback}${variant}`);
    }
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
    // The OpenAI-compatible publish lives ONLY in the opt-in overlay — the
    // base file must not publish 8182 at all.
    expect(channelsCompose).not.toContain(':8182');
    const apiOverlay = readFileSync(
      join(SKELETON_DIR, 'system', 'stack', 'guardian.compose.api.yml'),
      'utf-8',
    );
    expect(apiOverlay).toContain('${OP_API_BIND_ADDRESS:-127.0.0.1}:${OP_API_PORT:-3821}:8182');

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
  // Release-shipped skills are MANAGED assets: they live in system/, which
  // overwriteSystemTree refreshes wholesale, so a skill fix reaches an existing
  // home. Under knowledge/ they were seeded once and then frozen forever.
  test("shipped skills live in system/skills/, not the stash", () => {
    expect(existsSync(join(SKELETON_DIR, "system", "skills", "config-diagnostics", "SKILL.md"))).toBe(true);
    expect(existsSync(join(SKELETON_DIR, "knowledge", "skills"))).toBe(false);
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

// ── no new hardcoded host-UI/assistant port literals ────────────────────
//
// "Which port?" already had ~7 independent answers before Phase 1
// consolidated them into STACK_DEFAULTS (defaults.ts) plus the resolvers
// that read it (resolveHostUiPort/resolveUiListenEnv in network-contract.ts,
// resolveAssistantEndpoint in assistant-endpoint.ts): three separate
// hand-rolled `3880` constants, and the 3800/3810 default-port swap
// implemented three times with heuristics that disagreed at the edges. This
// is a permanent guard against a NEW hardcoded copy of one of those three
// numbers being added anywhere else in packages/*/src.
//
// Compose's own `${OP_UI_PORT:-3800}`-style interpolation fallbacks are
// sanctioned too (packages/skeleton/system/stack/*.yml, already pinned
// verbatim by the "every host-published listener uses a FLAT bind" test
// above) but packages/skeleton has no src/ directory, so this scan never
// reaches them — nothing further to exempt for that case.

describe("no new hardcoded 3880/3800/3810 outside STACK_DEFAULTS, compose fallbacks, and tests", () => {
  const PORT_LITERAL_RE = /\b(3880|3800|3810)\b/;

  // The one file allowed to DEFINE these numbers.
  const CANONICAL_DEFAULTS_FILE = join("packages", "lib", "src", "control-plane", "defaults.ts");

  // Every other occurrence needs a named, reasoned exemption, matched against
  // the OFFENDING LINE'S CONTENT (not a line number, which drifts as
  // unrelated lines above it change). Keep this list small — a growing
  // allowlist is a sign the ban needs a real fix upstream, not a wider
  // exemption. `snippet` only needs to be specific enough to identify this
  // one literal in this one file.
  type Allowance = { file: string; snippet: string; reason: string };
  const ALLOWLIST: Allowance[] = [
    {
      file: join("packages", "ui", "src", "routes", "setup", "steps", "DeployStep.svelte"),
      snippet: "window.location.port) || 3880",
      reason:
        "Browser-side fallback: this code runs in the browser and cannot import a server-side constant.",
    },
    {
      file: join("packages", "ui", "src", "routes", "setup", "steps", "DeployStep.svelte"),
      snippet: "deployData.ports?.ui ?? 3800",
      reason: "Same browser-side reasoning as the window.location.port fallback above it.",
    },
    {
      file: join("packages", "ui", "src", "routes", "setup", "steps", "DeployStep.svelte"),
      snippet: "deployData.ports?.assistant ?? 3810",
      reason: "Same browser-side reasoning as the window.location.port fallback above it.",
    },
  ];

  /** Blank out `'...'` / `"..."` string contents so quoted digits (help text, URL examples, doc placeholders) never match. */
  function stripQuotedStrings(line: string): string {
    return line.replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  }

  /** 1-based line numbers where a bare (non-string, non-comment) port literal appears, with the raw line text for allowlist matching. */
  function scanForPortLiterals(filePath: string): { line: number; text: string }[] {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    const offenders: { line: number; text: string }[] = [];
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const trimmed = line.trim();
      if (inBlockComment) {
        const end = line.indexOf("*/");
        if (end === -1) continue;
        line = line.slice(end + 2);
        inBlockComment = false;
      } else if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
        if (trimmed.startsWith("/*") && !trimmed.includes("*/")) inBlockComment = true;
        continue;
      } else {
        const blockStart = line.indexOf("/*");
        if (blockStart !== -1 && !line.slice(blockStart).includes("*/")) {
          line = line.slice(0, blockStart);
          inBlockComment = true;
        }
      }
      const noStrings = stripQuotedStrings(line);
      const commentIdx = noStrings.indexOf("//");
      const codePart = commentIdx !== -1 ? noStrings.slice(0, commentIdx) : noStrings;
      if (PORT_LITERAL_RE.test(codePart)) offenders.push({ line: i + 1, text: line.trim() });
    }
    return offenders;
  }

  function listSourceFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir, { recursive: true, withFileTypes: true }) as Array<
      import("node:fs").Dirent & { parentPath?: string; path?: string }
    >;
    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|svelte)$/.test(entry.name)) continue;
      if (/\.(test|vitest)\.ts$/.test(entry.name)) continue;
      const parent = entry.parentPath ?? entry.path;
      if (!parent) continue;
      files.push(join(parent, entry.name));
    }
    return files;
  }

  test("every 3880/3800/3810 in packages/*/src lives in defaults.ts, a test file, or the allowlist", () => {
    const packagesDir = join(REPO_ROOT, "packages");
    const packageNames = readdirSync(packagesDir).filter((name) =>
      statSync(join(packagesDir, name)).isDirectory(),
    );

    const failures: string[] = [];
    for (const pkg of packageNames) {
      const srcDir = join(packagesDir, pkg, "src");
      for (const file of listSourceFiles(srcDir)) {
        const relPath = relative(REPO_ROOT, file);
        if (relPath === CANONICAL_DEFAULTS_FILE) continue;
        for (const offender of scanForPortLiterals(file)) {
          const allowed = ALLOWLIST.some((a) => a.file === relPath && offender.text.includes(a.snippet));
          if (allowed) continue;
          failures.push(`${relPath}:${offender.line}: ${offender.text}`);
        }
      }
    }

    const message =
      `Hardcoded 3880/3800/3810 found outside STACK_DEFAULTS and the allowlist:\n${failures.join("\n")}\n\n` +
      `Every host-UI/assistant port default lives in packages/lib/src/control-plane/defaults.ts ` +
      `(STACK_DEFAULTS) — import it (or resolveHostUiPort/resolveUiListenEnv/resolveAssistantEndpoint) ` +
      `instead of re-declaring the number. If this genuinely cannot import a shared constant (e.g. ` +
      `browser-only code), add a reasoned entry to this test's ALLOWLIST instead of weakening the pattern.`;
    expect(failures, message).toEqual([]);
  });
});
