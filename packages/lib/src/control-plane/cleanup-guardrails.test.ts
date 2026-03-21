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
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
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
      const filename = path.split("/").pop()!;
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

// ── Guardrail 3: Compose preflight and service discovery are available ──

describe("guardrail: compose preflight and service discovery exports", () => {
  test("composePreflight is exported from docker.ts", async () => {
    const mod = await import("./docker.js");
    expect(typeof mod.composePreflight).toBe("function");
  });

  test("composeConfigServices is exported from docker.ts", async () => {
    const mod = await import("./docker.js");
    expect(typeof mod.composeConfigServices).toBe("function");
  });
});

// ── Guardrail 4: Service discovery is not filename-derived ────────────

describe("guardrail: no filename-derived service inference", () => {
  test("lifecycle.ts buildManagedServices does not scan config/components filenames", () => {
    const lifecycleTs = readFileSync(join(LIB_CONTROL_PLANE_DIR, "lifecycle.ts"), "utf-8");
    // Should not contain patterns like `.replace(/\.yml$/, "")` for service name extraction
    expect(lifecycleTs).not.toContain('.replace(/\\.yml$/');
    // Should not reference discoverComponentOverlays
    expect(lifecycleTs).not.toContain("discoverComponentOverlays");
  });

  test("channels.ts does not scan config/components for channel discovery", () => {
    const channelsTs = readFileSync(join(LIB_CONTROL_PLANE_DIR, "channels.ts"), "utf-8");
    // Active code should not reference config/components path
    const activeLines = channelsTs.split("\n").filter(
      (l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.includes("@deprecated")
    );
    const hasConfigComponents = activeLines.some((l) => l.includes("config/components"));
    expect(hasConfigComponents).toBe(false);
  });
});

// ── Guardrail 5: Env schema paths are correct ──────────────────────────

describe("guardrail: env schema validation paths", () => {
  test("validate.ts uses correct nested vault schema paths", () => {
    const validateTs = readFileSync(join(LIB_CONTROL_PLANE_DIR, "validate.ts"), "utf-8");
    // Must use nested paths
    expect(validateTs).toContain("vaultDir}/user/user.env.schema");
    expect(validateTs).toContain("vaultDir}/stack/stack.env.schema");
    // Must NOT use flat paths
    expect(validateTs).not.toContain("vaultDir}/user.env.schema");
    expect(validateTs).not.toContain("vaultDir}/system.env.schema");
  });
});
