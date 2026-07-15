/**
 * Cleanup guardrail tests — prevent reintroduction of cleaned-up patterns.
 *
 * These tests verify the 0.10.0 cleanup contract:
 * 1. No runtime config/components references
 * 2. No hardcoded compose project names in orchestration code
 * 3. Lifecycle preflight runs compose config before mutation
 * 4. Service discovery is compose-derived, not filename-derived
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveComposeProjectName } from "./docker.js";

// ── Helpers ───────────────────────────────────────────────────────────

const LIB_CONTROL_PLANE_DIR = join(import.meta.dir);

/** Read all .ts source files (not tests, not .d.ts) in control-plane/ */
function readSourceFiles(): { path: string; content: string }[] {
  const files = readdirSync(LIB_CONTROL_PLANE_DIR);
  return files
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".vitest.ts") && !f.endsWith(".d.ts"))
    .map((f) => ({
      path: join(LIB_CONTROL_PLANE_DIR, f),
      content: readFileSync(join(LIB_CONTROL_PLANE_DIR, f), "utf-8"),
    }));
}

// ── Guardrail 1: No config/components in active runtime code ──────────

describe("guardrail: no config/components runtime references", () => {
  test("source files do not reference config/components in active code", () => {
    const files = readSourceFiles();
    const violations: string[] = [];

    for (const { path, content } of files) {
      const filename = path.slice(path.lastIndexOf("/") + 1);
      // Skip this test file itself
      if (filename === "cleanup-guardrails.test.ts") continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments and @deprecated stubs
        if (line.trim().startsWith("//") || line.trim().startsWith("*") || line.trim().startsWith("/**")) continue;
        // Skip string literals in deprecation messages
        if (line.includes("@deprecated")) continue;

        if (line.includes("config/components") || line.includes("config\\components")) {
          violations.push(`${filename}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ── Guardrail 2: No hardcoded project names in compose orchestration ──

describe("guardrail: no hardcoded compose project names", () => {
  test("docker.ts does not contain hardcoded --project-name openpalm", () => {
    const dockerTs = readFileSync(join(LIB_CONTROL_PLANE_DIR, "docker.ts"), "utf-8");
    // The only allowed reference is the DEFAULT inside resolveComposeProjectName()
    const matches = dockerTs.match(/--project-name.*openpalm/g) ?? [];
    expect(matches.length).toBe(0);
  });

  test("resolveComposeProjectName respects OP_PROJECT_NAME", () => {
    const original = process.env.OP_PROJECT_NAME;
    try {
      process.env.OP_PROJECT_NAME = "custom-project";
      expect(resolveComposeProjectName()).toBe("custom-project");
    } finally {
      if (original !== undefined) {
        process.env.OP_PROJECT_NAME = original;
      } else {
        delete process.env.OP_PROJECT_NAME;
      }
    }
  });

  test("resolveComposeProjectName defaults to openpalm", () => {
    const original = process.env.OP_PROJECT_NAME;
    try {
      delete process.env.OP_PROJECT_NAME;
      expect(resolveComposeProjectName()).toBe("openpalm");
    } finally {
      if (original !== undefined) {
        process.env.OP_PROJECT_NAME = original;
      }
    }
  });
});

// ── Guardrail 3: Compose preflight is called before mutation ──────────

describe("guardrail: compose preflight before mutation", () => {
  test("composePreflight is exported from docker.ts", async () => {
    const mod = await import("./docker.js");
    expect(typeof mod.composePreflight).toBe("function");
  });

  test("composeConfigServices is exported from docker.ts", async () => {
    const mod = await import("./docker.js");
    expect(typeof mod.composeConfigServices).toBe("function");
  });

  test("preflight error is routed through the shared structured-field helper", () => {
    // reconcileCore must delegate the failed-preflight message to the single
    // source of truth buildComposePreflightError so lib and the CLI never
    // diverge, and that helper must surface the compose inputs as structured
    // fields (Files / Env files / Profiles / Project) — no message content lost.
    const lifecycleTs = readFileSync(join(LIB_CONTROL_PLANE_DIR, "lifecycle.ts"), "utf-8");
    expect(lifecycleTs).toContain(
      "buildComposePreflightError({ files, envFiles, profiles }, preflight.stderr)"
    );
    // The reconcileCore path no longer hand-builds the message inline.
    expect(lifecycleTs).not.toContain("Env files: ${envFiles.filter(existsSync)");

    const dockerTs = readFileSync(join(LIB_CONTROL_PLANE_DIR, "docker.ts"), "utf-8");
    expect(dockerTs).toContain("Files: ${files.join");
    expect(dockerTs).toContain("Env files: ${envFiles.filter(existsSync)");
    expect(dockerTs).toContain("Profiles: ${profiles.join");
    expect(dockerTs).toContain("Project: ${project}");
  });
});

// ── Guardrail 4: Service discovery is not filename-derived ────────────

describe("guardrail: compose-derived service discovery", () => {
  test("lifecycle.ts buildManagedServices uses composeConfigServices", () => {
    const lifecycleTs = readFileSync(join(LIB_CONTROL_PLANE_DIR, "lifecycle.ts"), "utf-8");
    // Must use compose-derived discovery
    expect(lifecycleTs).toContain("composeConfigServices");
    // Should not contain filename-scanning patterns
    expect(lifecycleTs).not.toContain('.replace(/\\.yml$/');
    // Should not reference discoverComponentOverlays
    expect(lifecycleTs).not.toContain("discoverComponentOverlays");
  });

  test("portals.ts does not scan config/components for portal discovery", () => {
    const portalsTs = readFileSync(join(LIB_CONTROL_PLANE_DIR, "portals.ts"), "utf-8");
    // Active code should not reference config/components path
    const activeLines = portalsTs.split("\n").filter(
      (l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.includes("@deprecated")
    );
    const hasConfigComponents = activeLines.some((l) => l.includes("config/components"));
    expect(hasConfigComponents).toBe(false);
  });
});

// ── Guardrail 5: No varlock or .env.schema references in validate.ts ───

describe("guardrail: validate.ts is varlock-free", () => {
  test("validate.ts does not import child_process or read .env.schema", () => {
    const validateTs = readFileSync(join(LIB_CONTROL_PLANE_DIR, "validate.ts"), "utf-8");
    // Post-#391: validation is key-presence only — no schema files, no binary.
    expect(validateTs).not.toContain("node:child_process");
    expect(validateTs).not.toContain("execFile");
    expect(validateTs).not.toContain("VARLOCK_BIN");
    expect(validateTs).not.toContain(".env.schema");
  });
});

// ── Guardrail 6: No deprecated split-root env vars in non-test source ──

describe("guardrail: no deprecated OP_CONFIG_HOME/OP_STATE_HOME/OP_DATA_HOME", () => {
  test("source files do not reference split-root env vars", () => {
    const files = readSourceFiles();
    const deprecated = ["OP_CONFIG_HOME", "OP_STATE_HOME", "OP_DATA_HOME"];
    const violations: string[] = [];

    for (const { path, content } of files) {
      const filename = path.slice(path.lastIndexOf("/") + 1);
      if (filename === "cleanup-guardrails.test.ts") continue;
      // home.ts may contain backward-compat resolution — skip it
      if (filename === "home.ts") continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
        for (const d of deprecated) {
          if (line.includes(d)) {
            violations.push(`${filename}:${i + 1}: ${d} — ${line.trim()}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ── Guardrail 7: No secrets.env references in active source ──────────

describe("guardrail: no secrets.env references", () => {
  test("source files do not reference secrets.env in active code", () => {
    const files = readSourceFiles();
    const violations: string[] = [];

    for (const { path, content } of files) {
      const filename = path.slice(path.lastIndexOf("/") + 1);
      if (filename === "cleanup-guardrails.test.ts") continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
        if (line.includes("@deprecated")) continue;
        // Allow string mentions in error messages that reference user.env or stack.env
        if (line.includes("secrets.env")) {
          violations.push(`${filename}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ── Guardrail 8: .openpalm/stack/start.sh does not exist ─────────────

describe("guardrail: .openpalm/stack/start.sh is absent", () => {
  test(".openpalm/stack/start.sh does not exist in repo", () => {
    // start.sh was deleted as part of P1-5 (0.10.0 cleanup).
    // All compose orchestration goes through @openpalm/lib backed CLI/admin paths.
    // This test prevents accidental reintroduction.
    const repoRoot = join(import.meta.dir, "../../../../..");
    const legacyScript = join(repoRoot, ".openpalm/stack/start.sh");
    let exists = false;
    try {
      readFileSync(legacyScript);
      exists = true;
    } catch {
      // expected: file does not exist
    }
    expect(exists).toBe(false);
  });

  test("control-plane source files do not reference .openpalm/stack/start.sh", () => {
    const files = readSourceFiles();
    const violations: string[] = [];

    for (const { path, content } of files) {
      const filename = path.slice(path.lastIndexOf("/") + 1);
      if (filename === "cleanup-guardrails.test.ts") continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
        if (line.includes(".openpalm/stack/start.sh") || line.includes("openpalm/stack/start.sh")) {
          violations.push(`${filename}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ── Guardrail 9: component/instance system removed ──────────────────

describe("guardrail: component/instance system removed", () => {
  test("components.ts no longer exists", () => {
    const exists = readdirSync(LIB_CONTROL_PLANE_DIR).includes("components.ts");
    expect(exists).toBe(false);
  });

  test("instance-lifecycle.ts no longer exists", () => {
    const exists = readdirSync(LIB_CONTROL_PLANE_DIR).includes("instance-lifecycle.ts");
    expect(exists).toBe(false);
  });

  test("component-secrets.ts no longer exists", () => {
    const exists = readdirSync(LIB_CONTROL_PLANE_DIR).includes("component-secrets.ts");
    expect(exists).toBe(false);
  });

  test("no source file references data/components or data/catalog", () => {
    const sources = readSourceFiles();
    for (const { content } of sources) {
      expect(content).not.toContain("data/components");
      expect(content).not.toContain("data/catalog");
    }
  });
});

// ── Guardrail 10: channel_lan network + CHANNEL_NAME marker removed (#490) ──

describe("guardrail: no channel_lan in skeleton stack assets", () => {
  test("skeleton compose files do not define or reference channel_lan", () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const skeletonStackDir = join(repoRoot, "packages/skeleton/system/stack");
    const files = readdirSync(skeletonStackDir).filter((f) => f.endsWith(".yml"));
    const violations: string[] = [];

    for (const f of files) {
      const content = readFileSync(join(skeletonStackDir, f), "utf-8");
      if (content.includes("channel_lan")) {
        violations.push(f);
      }
    }

    const readmePath = join(skeletonStackDir, "README.md");
    const readme = readFileSync(readmePath, "utf-8");
    if (readme.includes("channel_lan")) {
      violations.push("README.md");
    }

    expect(violations).toEqual([]);
  });
});

describe("guardrail: no CHANNEL_NAME in control-plane source", () => {
  test("control-plane source files do not reference CHANNEL_NAME", () => {
    const files = readSourceFiles();
    const violations: string[] = [];

    for (const { path, content } of files) {
      const filename = path.slice(path.lastIndexOf("/") + 1);
      if (filename === "cleanup-guardrails.test.ts") continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("CHANNEL_NAME")) {
          violations.push(`${filename}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ── Guardrail 11: overlay channel_lan deprecation guard is wired (#490) ────

describe("guardrail: overlay deprecation guard is wired", () => {
  test("checks the user overlay before snapshotting or writing managed files", () => {
    const lifecycleTs = readFileSync(join(LIB_CONTROL_PLANE_DIR, "lifecycle.ts"), "utf-8");
    const fnStart = lifecycleTs.indexOf("async function applyManagedFiles(");
    expect(fnStart).toBeGreaterThan(-1);

    const guardIdx = lifecycleTs.indexOf("checkCustomComposeChannelLan(", fnStart);
    const snapshotIdx = lifecycleTs.indexOf("snapshotCurrentState(", fnStart);
    const applyIdx = lifecycleTs.indexOf("await applyHome(", fnStart);

    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(snapshotIdx);
    expect(snapshotIdx).toBeLessThan(applyIdx);
  });
});
