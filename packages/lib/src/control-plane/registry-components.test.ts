/**
 * Tests for the registry component directory format.
 *
 * Validates that all components in .openpalm/registry/addons/ follow the
 * component conventions: compose.yml with required labels, .env.schema
 * with documented variables, proper service naming, and no security
 * violations.
 *
 * Two component shapes are accepted:
 *
 *   1. Full addons — compose.yml + .env.schema. They introduce a new
 *      service, declare env vars, and must satisfy the full structural
 *      checklist (labels, network, healthcheck, restart policy, sensitive
 *      fields).
 *   2. Overlay-only addons — compose.yml only. They patch existing
 *      services (ports, env, volumes) instead of introducing new ones,
 *      so they have no env vars to document and no service-shaped
 *      requirements. They still must satisfy the security invariants:
 *      no INSTANCE_ID, no container_name, no INSTANCE_DIR, no vault
 *      directory mounts, no docker socket.
 */
import { describe, expect, it } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Resolve path from repo root */
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const REGISTRY_DIR = join(REPO_ROOT, ".openpalm/registry/addons");

/** List all component directories in the registry */
function listComponentDirs(): string[] {
  if (!existsSync(REGISTRY_DIR)) return [];
  return readdirSync(REGISTRY_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Overlay-only addons ship compose.yml only — no .env.schema. */
function isOverlayOnly(componentId: string): boolean {
  return !existsSync(join(REGISTRY_DIR, componentId, ".env.schema"));
}

function listFullAddonIds(componentIds: string[]): string[] {
  return componentIds.filter((id) => !isOverlayOnly(id));
}

function listOverlayOnlyAddonIds(componentIds: string[]): string[] {
  return componentIds.filter(isOverlayOnly);
}

/** Read a file from a component directory */
function readComponentFile(componentId: string, filename: string): string {
  return readFileSync(join(REGISTRY_DIR, componentId, filename), "utf-8");
}

/** Parse .env.schema into { variable, annotations, defaultValue, comments } entries */
function parseEnvSchema(content: string): Array<{
  variable: string;
  defaultValue: string;
  annotations: string[];
  comments: string[];
}> {
  const entries: Array<{
    variable: string;
    defaultValue: string;
    annotations: string[];
    comments: string[];
  }> = [];

  const lines = content.split("\n");
  let pendingComments: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("#")) {
      pendingComments.push(trimmed);
      continue;
    }

    if (trimmed === "" || trimmed === "---") {
      // Blank line or section separator — keep accumulating comments
      // for the next variable.
      continue;
    }

    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
    if (match) {
      const variable = match[1];
      const defaultValue = match[2];

      // Extract @annotations from pending comments
      const annotations: string[] = [];
      for (const c of pendingComments) {
        const annots = c.match(/@[a-z]+/g);
        if (annots) annotations.push(...annots);
      }

      entries.push({
        variable,
        defaultValue,
        annotations,
        comments: [...pendingComments],
      });
      pendingComments = [];
    }
  }

  return entries;
}

// ── Discovery Tests ──────────────────────────────────────────────────────

describe("registry component discovery", () => {
  const componentIds = listComponentDirs();

  it("finds at least one component in the registry", () => {
    expect(componentIds.length).toBeGreaterThan(0);
  });

  it("contains the expected core components", () => {
    expect(componentIds).toContain("chat");
    expect(componentIds).toContain("api");
    expect(componentIds).toContain("discord");
    expect(componentIds).toContain("slack");
    expect(componentIds).toContain("voice");
  });

  it("component IDs are valid (lowercase alphanumeric + hyphens)", () => {
    const validIdRe = /^[a-z0-9][a-z0-9-]{0,62}$/;
    for (const id of componentIds) {
      expect(validIdRe.test(id)).toBe(true);
    }
  });
});

// ── Required Files Tests ─────────────────────────────────────────────────

describe("registry component required files", () => {
  const componentIds = listComponentDirs();
  const fullAddonIds = listFullAddonIds(componentIds);

  for (const id of componentIds) {
    it(`${id}: has compose.yml`, () => {
      expect(existsSync(join(REGISTRY_DIR, id, "compose.yml"))).toBe(true);
    });
  }

  for (const id of fullAddonIds) {
    it(`${id}: has .env.schema (full addon)`, () => {
      expect(existsSync(join(REGISTRY_DIR, id, ".env.schema"))).toBe(true);
    });
  }
});

// ── Overlay-only Addon Tests ─────────────────────────────────────────────

describe("registry overlay-only addons", () => {
  const componentIds = listComponentDirs();
  const overlayIds = listOverlayOnlyAddonIds(componentIds);

  it("at least one overlay-only addon (ssh) is recognized as valid", () => {
    expect(overlayIds).toContain("ssh");
  });

  for (const id of overlayIds) {
    describe(id, () => {
      it("ships only compose.yml (no .env.schema, no entrypoint, no Dockerfile)", () => {
        const dirEntries = readdirSync(join(REGISTRY_DIR, id));
        // compose.yml is required; an optional README.md is allowed; nothing
        // else (no .env.schema, no entrypoint*, no Dockerfile, no scripts).
        const allowed = new Set(["compose.yml", "README.md"]);
        for (const file of dirEntries) {
          expect(allowed.has(file)).toBe(true);
        }
      });

      it("compose.yml does not introduce a new service (no image: or build:)", () => {
        // Overlay-only addons may patch existing services with new ports/env,
        // but they MUST NOT introduce a new service that needs its own
        // network/healthcheck/restart contract — those would belong in a
        // full addon. Reject service definition keys that imply a new
        // service body. A pure overlay only sets `ports:`, `environment:`,
        // `volumes:`, etc. on already-defined services.
        const compose = readComponentFile(id, "compose.yml");
        expect(compose).not.toMatch(/^\s+image:\s/m);
        expect(compose).not.toMatch(/^\s+build:\s/m);
      });
    });
  }
});

// ── Compose Overlay Validation Tests ─────────────────────────────────────

describe("registry compose.yml validation", () => {
  const componentIds = listComponentDirs();
  const fullAddonIds = listFullAddonIds(componentIds);

  // Full-addon-only assertions: anything that requires a service body
  // (labels, network, healthcheck, restart policy) is checked here.
  for (const id of fullAddonIds) {
    describe(id, () => {
      const compose = readComponentFile(id, "compose.yml");

      it("has openpalm.name label", () => {
        expect(compose).toMatch(/openpalm\.name:/);
      });

      it("has openpalm.description label", () => {
        expect(compose).toMatch(/openpalm\.description:/);
      });

      it("joins a valid stack network", () => {
        const hasValidNetwork = compose.includes("channel_lan") || compose.includes("channel_public") || compose.includes("assistant_net");
        expect(hasValidNetwork).toBe(true);
      });

      it("has restart policy", () => {
        expect(compose).toMatch(/restart:\s/);
      });

      it("has healthcheck", () => {
        expect(compose).toMatch(/healthcheck:/);
      });
    });
  }

  // Security/hygiene assertions apply to ALL addons (full and overlay-only).
  for (const id of componentIds) {
    describe(`${id} (security)`, () => {
      const compose = readComponentFile(id, "compose.yml");

      it("uses static service name (no INSTANCE_ID)", () => {
        expect(compose).not.toContain("${INSTANCE_ID}");
      });

      it("does not use container_name", () => {
        expect(compose).not.toMatch(/container_name:/);
      });

      it("does not reference INSTANCE_DIR", () => {
        expect(compose).not.toContain("${INSTANCE_DIR}");
      });

      it("does not mount vault directory (single-file mounts allowed)", () => {
        // Directory-level vault mounts are a security violation — no container may mount the full vault.
        // Single-file mounts like vault/user/ov.conf are allowed (the source must end with a filename).
        const lines = compose.split("\n");
        for (const line of lines) {
          if (line.match(/^\s*-\s+.*vault.*:/)) {
            // Extract the source portion (before first colon that follows a path)
            const match = line.match(/^\s*-\s+(.+?):/);
            if (match) {
              const source = match[1];
              // Allow single-file vault mounts (path ends with a file, i.e. has an extension or
              // a non-directory final segment). Block bare vault/ or vault/<dir>/ mounts.
              if (/vault\b/i.test(source) && !/vault\/.*\.[a-z]+$/i.test(source)) {
                throw new Error(`Vault directory mount detected: ${line.trim()}`);
              }
            }
          }
        }
      });

      it("does not mount docker socket", () => {
        expect(compose).not.toContain("/var/run/docker.sock");
      });

      it("has a comment header describing the component", () => {
        expect(compose.startsWith("#")).toBe(true);
      });
    });
  }
});

// ── .env.schema Validation Tests ─────────────────────────────────────────

describe("registry .env.schema validation", () => {
  const componentIds = listComponentDirs();
  const fullAddonIds = listFullAddonIds(componentIds);

  for (const id of fullAddonIds) {
    describe(id, () => {
      const schema = readComponentFile(id, ".env.schema");
      const entries = parseEnvSchema(schema);

      it("is non-empty", () => {
        expect(schema.length).toBeGreaterThan(0);
      });

      it("has at least one variable definition", () => {
        expect(entries.length).toBeGreaterThan(0);
      });

      it("does not include INSTANCE_ID (removed)", () => {
        const names = entries.map((e) => e.variable);
        expect(names).not.toContain("INSTANCE_ID");
      });

      it("does not include INSTANCE_DIR (removed)", () => {
        const names = entries.map((e) => e.variable);
        expect(names).not.toContain("INSTANCE_DIR");
      });

      it("has at least one @required variable", () => {
        const requiredEntries = entries.filter((e) =>
          e.annotations.includes("@required")
        );
        expect(requiredEntries.length).toBeGreaterThan(0);
      });

      it("variable names are valid (uppercase with underscores)", () => {
        const validVarRe = /^[A-Z_][A-Z0-9_]*$/;
        for (const entry of entries) {
          expect(validVarRe.test(entry.variable)).toBe(true);
        }
      });

      it("every variable has at least one comment line above it", () => {
        for (const entry of entries) {
          expect(entry.comments.length).toBeGreaterThan(0);
        }
      });

      it("does not contain vault references", () => {
        expect(schema.toLowerCase()).not.toContain("vault/");
      });
    });
  }
});

// ── Sensitive Fields Tests ───────────────────────────────────────────────

describe("registry component sensitive fields", () => {
  const componentIds = listComponentDirs();
  const fullAddonIds = listFullAddonIds(componentIds);

  for (const id of fullAddonIds) {
    it(`${id}: has at least one @sensitive field (channel secret)`, () => {
      // ollama is a local inference server — no channel secret or API key needed
      if (id === "ollama") return;
      const schema = readComponentFile(id, ".env.schema");
      const entries = parseEnvSchema(schema);
      const sensitiveEntries = entries.filter((e) =>
        e.annotations.includes("@sensitive")
      );
      expect(sensitiveEntries.length).toBeGreaterThan(0);
    });
  }
});

// ── Cross-Component Consistency Tests ────────────────────────────────────

describe("cross-component consistency", () => {
  const componentIds = listComponentDirs();
  const fullAddonIds = listFullAddonIds(componentIds);

  it("no duplicate openpalm.name labels across full addons", () => {
    const names = new Set<string>();
    for (const id of fullAddonIds) {
      const compose = readComponentFile(id, "compose.yml");
      const nameMatch = compose.match(/openpalm\.name:\s*(.+)/);
      expect(nameMatch).not.toBeNull();
      const name = nameMatch![1].trim();
      expect(names.has(name)).toBe(false);
      names.add(name);
    }
  });

  it("all full addons join a valid stack network", () => {
    for (const id of fullAddonIds) {
      const compose = readComponentFile(id, "compose.yml");
      const hasValidNetwork = compose.includes("channel_lan") || compose.includes("channel_public") || compose.includes("assistant_net");
      expect(hasValidNetwork).toBe(true);
    }
  });

  it("no compose file uses INSTANCE_ID anywhere", () => {
    for (const id of componentIds) {
      const compose = readComponentFile(id, "compose.yml");
      expect(compose).not.toContain("INSTANCE_ID");
    }
  });
});
