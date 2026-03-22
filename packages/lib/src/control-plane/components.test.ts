import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isValidInstanceId,
  isReservedName,
  parseComposeLabels,
  discoverComponents,
} from "./components.js";

// ── Helpers ────────────────────────────────────────────────────────────

let tempDir: string;

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeComponentDir(
  baseDir: string,
  name: string,
  opts: {
    compose?: string;
    schema?: string;
  } = {}
): string {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });

  const compose = opts.compose ?? `
services:
  openpalm-\${INSTANCE_ID}:
    image: openpalm/channel-${name}:latest
    labels:
      openpalm.name: "${name}"
      openpalm.description: "Test component ${name}"
      openpalm.icon: box
      openpalm.category: testing
`;
  writeFileSync(join(dir, "compose.yml"), compose);
  writeFileSync(join(dir, ".env.schema"), opts.schema ?? `# ${name} schema\nTEST_VAR=default\n`);

  return dir;
}

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ── isValidInstanceId ──────────────────────────────────────────────────

describe("isValidInstanceId", () => {
  test("accepts valid IDs", () => {
    expect(isValidInstanceId("discord")).toBe(true);
    expect(isValidInstanceId("discord-main")).toBe(true);
    expect(isValidInstanceId("my-bot-1")).toBe(true);
    expect(isValidInstanceId("a")).toBe(true);
    expect(isValidInstanceId("0")).toBe(true);
    expect(isValidInstanceId("a1b2c3")).toBe(true);
  });

  test("rejects invalid IDs", () => {
    expect(isValidInstanceId("")).toBe(false);
    expect(isValidInstanceId("-starts-with-hyphen")).toBe(false);
    expect(isValidInstanceId("HAS-UPPERCASE")).toBe(false);
    expect(isValidInstanceId("has spaces")).toBe(false);
    expect(isValidInstanceId("has_underscores")).toBe(false);
    expect(isValidInstanceId("has.dots")).toBe(false);
    expect(isValidInstanceId("a".repeat(64))).toBe(false); // too long
  });

  test("accepts max-length IDs (63 chars)", () => {
    expect(isValidInstanceId("a" + "b".repeat(62))).toBe(true);
  });
});

// ── isReservedName ─────────────────────────────────────────────────────

describe("isReservedName", () => {
  test("recognizes core service names", () => {
    expect(isReservedName("assistant")).toBe(true);
    expect(isReservedName("guardian")).toBe(true);
    expect(isReservedName("memory")).toBe(true);
    expect(isReservedName("scheduler")).toBe(true);
  });

  test("recognizes optional service names", () => {
    expect(isReservedName("admin")).toBe(true);
    expect(isReservedName("docker-socket-proxy")).toBe(true);
  });

  test("stale compose aliases are no longer reserved", () => {
    // COMPOSE_SERVICE_ALIASES was removed — these names are no longer reserved
    expect(isReservedName("opencode-core")).toBe(false);
    expect(isReservedName("gateway")).toBe(false);
    expect(isReservedName("openmemory")).toBe(false);
  });

  test("rejects non-reserved names", () => {
    expect(isReservedName("discord")).toBe(false);
    expect(isReservedName("my-bot")).toBe(false);
    expect(isReservedName("ollama")).toBe(false);
  });
});

// ── parseComposeLabels ─────────────────────────────────────────────────

describe("parseComposeLabels", () => {
  test("parses all openpalm labels", () => {
    const dir = writeComponentDir(tempDir, "test-component", {
      compose: `
services:
  test-svc:
    image: test:latest
    labels:
      openpalm.name: "Test Component"
      openpalm.description: "A test component"
      openpalm.icon: box
      openpalm.category: testing
      openpalm.docs: /docs/test.md
      openpalm.healthcheck: http://test:3000/health
`,
    });

    const labels = parseComposeLabels(join(dir, "compose.yml"));
    expect(labels).not.toBeNull();
    expect(labels!.name).toBe("Test Component");
    expect(labels!.description).toBe("A test component");
    expect(labels!.icon).toBe("box");
    expect(labels!.category).toBe("testing");
    expect(labels!.docs).toBe("/docs/test.md");
    expect(labels!.healthcheck).toBe("http://test:3000/health");
  });

  test("parses with only required labels", () => {
    const dir = writeComponentDir(tempDir, "minimal", {
      compose: `
services:
  min-svc:
    image: test:latest
    labels:
      openpalm.name: "Minimal"
      openpalm.description: "Just the basics"
`,
    });

    const labels = parseComposeLabels(join(dir, "compose.yml"));
    expect(labels).not.toBeNull();
    expect(labels!.name).toBe("Minimal");
    expect(labels!.description).toBe("Just the basics");
    expect(labels!.icon).toBeUndefined();
    expect(labels!.category).toBeUndefined();
  });

  test("returns null when name is missing", () => {
    const dir = writeComponentDir(tempDir, "no-name", {
      compose: `
services:
  svc:
    image: test:latest
    labels:
      openpalm.description: "No name"
`,
    });

    const labels = parseComposeLabels(join(dir, "compose.yml"));
    expect(labels).toBeNull();
  });

  test("returns null when description is missing", () => {
    const dir = writeComponentDir(tempDir, "no-desc", {
      compose: `
services:
  svc:
    image: test:latest
    labels:
      openpalm.name: "No Description"
`,
    });

    const labels = parseComposeLabels(join(dir, "compose.yml"));
    expect(labels).toBeNull();
  });

  test("returns null when no labels", () => {
    const dir = writeComponentDir(tempDir, "no-labels", {
      compose: `
services:
  svc:
    image: test:latest
`,
    });

    const labels = parseComposeLabels(join(dir, "compose.yml"));
    expect(labels).toBeNull();
  });

  test("returns null for non-existent file", () => {
    const labels = parseComposeLabels("/nonexistent/compose.yml");
    expect(labels).toBeNull();
  });

  test("returns null for invalid YAML", () => {
    const dir = join(tempDir, "bad-yaml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "compose.yml"), "{{not valid yaml");

    const labels = parseComposeLabels(join(dir, "compose.yml"));
    expect(labels).toBeNull();
  });

  test("picks first service with labels", () => {
    const dir = writeComponentDir(tempDir, "multi-svc", {
      compose: `
services:
  no-labels-svc:
    image: first:latest
  labeled-svc:
    image: second:latest
    labels:
      openpalm.name: "Second Service"
      openpalm.description: "This one has labels"
`,
    });

    const labels = parseComposeLabels(join(dir, "compose.yml"));
    expect(labels).not.toBeNull();
    expect(labels!.name).toBe("Second Service");
  });

  test("parses list-style labels", () => {
    const dir = writeComponentDir(tempDir, "list-labels", {
      compose: `
services:
  discord-svc:
    image: openpalm/channel-discord:latest
    labels:
      - "openpalm.name=Discord"
      - "openpalm.description=Discord channel adapter"
      - "openpalm.icon=message-circle"
      - "openpalm.category=messaging"
`,
    });

    const labels = parseComposeLabels(join(dir, "compose.yml"));
    expect(labels).not.toBeNull();
    expect(labels!.name).toBe("Discord");
    expect(labels!.description).toBe("Discord channel adapter");
    expect(labels!.icon).toBe("message-circle");
    expect(labels!.category).toBe("messaging");
  });

  test("returns null for list-style labels missing required fields", () => {
    const dir = writeComponentDir(tempDir, "list-labels-incomplete", {
      compose: `
services:
  svc:
    image: test:latest
    labels:
      - "openpalm.icon=box"
`,
    });

    const labels = parseComposeLabels(join(dir, "compose.yml"));
    expect(labels).toBeNull();
  });
});

// ── discoverComponents ─────────────────────────────────────────────────

describe("discoverComponents", () => {
  test("discovers components from builtin directory", () => {
    const builtinDir = join(tempDir, "builtin");
    const openpalmHome = join(tempDir, "home");
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(join(openpalmHome, "data", "catalog"), { recursive: true });

    writeComponentDir(builtinDir, "discord");
    writeComponentDir(builtinDir, "telegram");

    const components = discoverComponents(openpalmHome, builtinDir);
    expect(components).toHaveLength(2);

    const ids = components.map((c) => c.id).sort();
    expect(ids).toEqual(["discord", "telegram"]);

    const discord = components.find((c) => c.id === "discord")!;
    expect(discord.source).toBe("builtin");
    expect(discord.composePath).toContain("compose.yml");
    expect(discord.schemaPath).toContain(".env.schema");
  });

  test("discovers components from data/catalog", () => {
    const openpalmHome = join(tempDir, "home");
    const catalogDir = join(openpalmHome, "data", "catalog");
    mkdirSync(catalogDir, { recursive: true });

    writeComponentDir(catalogDir, "slack");

    const components = discoverComponents(openpalmHome);
    expect(components).toHaveLength(1);
    expect(components[0].id).toBe("slack");
    expect(components[0].source).toBe("registry");
  });

  test("registry overrides builtin", () => {
    const builtinDir = join(tempDir, "builtin");
    const openpalmHome = join(tempDir, "home");
    const catalogDir = join(openpalmHome, "data", "catalog");

    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(catalogDir, { recursive: true });

    writeComponentDir(builtinDir, "discord", {
      compose: `
services:
  svc:
    image: builtin:latest
    labels:
      openpalm.name: "Builtin Discord"
      openpalm.description: "From builtin"
`,
    });

    writeComponentDir(catalogDir, "discord", {
      compose: `
services:
  svc:
    image: registry:latest
    labels:
      openpalm.name: "Registry Discord"
      openpalm.description: "From registry"
`,
    });

    const components = discoverComponents(openpalmHome, builtinDir);
    expect(components).toHaveLength(1);
    expect(components[0].source).toBe("registry");
    expect(components[0].labels.name).toBe("Registry Discord");
  });

  test("skips directories missing compose.yml", () => {
    const builtinDir = join(tempDir, "builtin");
    const openpalmHome = join(tempDir, "home");
    mkdirSync(join(builtinDir, "incomplete"), { recursive: true });
    mkdirSync(join(openpalmHome, "data", "catalog"), { recursive: true });

    // Only schema, no compose
    writeFileSync(join(builtinDir, "incomplete", ".env.schema"), "# schema");

    const components = discoverComponents(openpalmHome, builtinDir);
    expect(components).toHaveLength(0);
  });

  test("skips directories missing .env.schema", () => {
    const builtinDir = join(tempDir, "builtin");
    const openpalmHome = join(tempDir, "home");
    mkdirSync(join(builtinDir, "incomplete"), { recursive: true });
    mkdirSync(join(openpalmHome, "data", "catalog"), { recursive: true });

    // Only compose, no schema
    writeFileSync(
      join(builtinDir, "incomplete", "compose.yml"),
      `services:\n  svc:\n    image: test:latest\n    labels:\n      openpalm.name: Test\n      openpalm.description: Test\n`
    );

    const components = discoverComponents(openpalmHome, builtinDir);
    expect(components).toHaveLength(0);
  });

  test("returns empty array when no sources exist", () => {
    const openpalmHome = join(tempDir, "empty-home");
    const components = discoverComponents(openpalmHome);
    expect(components).toEqual([]);
  });

  test("merges unique components from multiple sources", () => {
    const builtinDir = join(tempDir, "builtin");
    const openpalmHome = join(tempDir, "home");
    const catalogDir = join(openpalmHome, "data", "catalog");

    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(catalogDir, { recursive: true });

    writeComponentDir(builtinDir, "discord");
    writeComponentDir(builtinDir, "telegram");
    writeComponentDir(catalogDir, "slack");

    const components = discoverComponents(openpalmHome, builtinDir);
    expect(components).toHaveLength(3);

    const ids = components.map((c) => c.id).sort();
    expect(ids).toEqual(["discord", "slack", "telegram"]);
  });
});

