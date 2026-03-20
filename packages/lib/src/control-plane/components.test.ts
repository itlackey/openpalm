import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isValidInstanceId,
  isReservedName,
  parseComposeLabels,
  discoverComponents,
  validateOverlay,
  detectEnvInjectionCollisions,
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

  test("recognizes compose service names", () => {
    expect(isReservedName("opencode-core")).toBe(true);
    expect(isReservedName("gateway")).toBe(true);
    expect(isReservedName("openmemory")).toBe(true);
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

  test("discovers components from registry/catalog", () => {
    const openpalmHome = join(tempDir, "home");
    const catalogDir = join(openpalmHome, "data", "catalog");
    mkdirSync(catalogDir, { recursive: true });

    writeComponentDir(catalogDir, "slack");

    const components = discoverComponents(openpalmHome);
    expect(components).toHaveLength(1);
    expect(components[0].id).toBe("slack");
    expect(components[0].source).toBe("registry");
  });

  test("discovers components from user-local", () => {
    const openpalmHome = join(tempDir, "home");
    const userDir = join(openpalmHome, "config", "components");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(join(openpalmHome, "data", "catalog"), { recursive: true });

    writeComponentDir(userDir, "custom-bot");

    const components = discoverComponents(openpalmHome);
    expect(components).toHaveLength(1);
    expect(components[0].id).toBe("custom-bot");
    expect(components[0].source).toBe("user-local");
  });

  test("user-local overrides registry overrides builtin", () => {
    const builtinDir = join(tempDir, "builtin");
    const openpalmHome = join(tempDir, "home");
    const catalogDir = join(openpalmHome, "data", "catalog");
    const userDir = join(openpalmHome, "config", "components");

    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(catalogDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });

    // Same component ID in all three sources
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

    writeComponentDir(userDir, "discord", {
      compose: `
services:
  svc:
    image: user:latest
    labels:
      openpalm.name: "User Discord"
      openpalm.description: "From user"
`,
    });

    const components = discoverComponents(openpalmHome, builtinDir);
    expect(components).toHaveLength(1);
    expect(components[0].source).toBe("user-local");
    expect(components[0].labels.name).toBe("User Discord");
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

// ── validateOverlay ────────────────────────────────────────────────────

describe("validateOverlay", () => {
  test("accepts valid component overlay", () => {
    const dir = writeComponentDir(tempDir, "valid", {
      compose: `
services:
  openpalm-\${INSTANCE_ID}:
    image: openpalm/test:latest
    labels:
      openpalm.name: "Valid"
      openpalm.description: "A valid component"
    networks:
      - openpalm-internal
`,
    });

    const result = validateOverlay(join(dir, "compose.yml"));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects core service redefinition with non-environment keys", () => {
    const dir = join(tempDir, "core-redef");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "compose.yml"),
      `
services:
  assistant:
    image: custom-assistant:latest
    environment:
      CUSTOM_VAR: test
    volumes:
      - /data:/data
`
    );

    const result = validateOverlay(join(dir, "compose.yml"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("assistant") && e.includes("image"))).toBe(true);
    expect(result.errors.some((e) => e.includes("assistant") && e.includes("volumes"))).toBe(true);
  });

  test("allows core service extension with environment only", () => {
    const dir = join(tempDir, "core-ext");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "compose.yml"),
      `
services:
  openpalm-test:
    image: test:latest
    labels:
      openpalm.name: "Test"
      openpalm.description: "Test"
  assistant:
    environment:
      CUSTOM_VAR: test
      CUSTOM_URL: http://openpalm-test:3000
`
    );

    const result = validateOverlay(join(dir, "compose.yml"));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects vault mount", () => {
    const dir = join(tempDir, "vault-mount");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "compose.yml"),
      `
services:
  openpalm-evil:
    image: evil:latest
    labels:
      openpalm.name: "Evil"
      openpalm.description: "Mounts vault"
    volumes:
      - \${OP_HOME}/vault:/secrets
`
    );

    const result = validateOverlay(join(dir, "compose.yml"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("vault"))).toBe(true);
  });

  test("allows vault/user.env mount", () => {
    const dir = join(tempDir, "vault-user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "compose.yml"),
      `
services:
  openpalm-ok:
    image: ok:latest
    labels:
      openpalm.name: "OK"
      openpalm.description: "Only mounts vault/user.env"
    volumes:
      - \${OP_HOME}/vault/user.env:/app/user.env:ro
`
    );

    const result = validateOverlay(join(dir, "compose.yml"));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects privileged mode", () => {
    const dir = join(tempDir, "privileged");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "compose.yml"),
      `
services:
  openpalm-root:
    image: root:latest
    privileged: true
    labels:
      openpalm.name: "Root"
      openpalm.description: "Privileged component"
`
    );

    const result = validateOverlay(join(dir, "compose.yml"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("privileged"))).toBe(true);
  });

  test("warns about missing openpalm labels", () => {
    const dir = join(tempDir, "no-labels");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "compose.yml"),
      `
services:
  my-service:
    image: test:latest
`
    );

    const result = validateOverlay(join(dir, "compose.yml"));
    expect(result.valid).toBe(true); // labels are a warning, not an error
    expect(result.warnings.some((w) => w.includes("openpalm.name"))).toBe(true);
  });

  test("warns about port exposure on non-core services", () => {
    const dir = join(tempDir, "ports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "compose.yml"),
      `
services:
  openpalm-exposed:
    image: exposed:latest
    ports:
      - "8080:8080"
    labels:
      openpalm.name: "Exposed"
      openpalm.description: "Has ports"
`
    );

    const result = validateOverlay(join(dir, "compose.yml"));
    expect(result.valid).toBe(true); // ports are a warning, not an error
    expect(result.warnings.some((w) => w.includes("port") && w.includes("guardian"))).toBe(true);
  });

  test("warns about vault variable references in volumes", () => {
    const dir = join(tempDir, "vault-var");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "compose.yml"),
      `
services:
  openpalm-sneaky:
    image: sneaky:latest
    labels:
      openpalm.name: "Sneaky"
      openpalm.description: "Uses vault variable"
    volumes:
      - \${VAULT_DIR}:/secrets
`
    );

    const result = validateOverlay(join(dir, "compose.yml"));
    expect(result.warnings.some((w) => w.includes("variable reference") && w.includes("vault"))).toBe(true);
  });

  test("warns about case-insensitive vault variable references", () => {
    const dir = join(tempDir, "vault-var-case");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "compose.yml"),
      `
services:
  openpalm-tricky:
    image: tricky:latest
    labels:
      openpalm.name: "Tricky"
      openpalm.description: "Mixed-case vault var"
    volumes:
      - \${MY_VAULT_PATH}:/data
`
    );

    const result = validateOverlay(join(dir, "compose.yml"));
    expect(result.warnings.some((w) => w.includes("variable reference") && w.includes("vault"))).toBe(true);
  });

  test("returns error for non-existent file with path in message", () => {
    const fakePath = "/nonexistent/compose.yml";
    const result = validateOverlay(fakePath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("parse") && e.includes(fakePath))).toBe(true);
  });

  test("returns error for empty compose", () => {
    const dir = join(tempDir, "empty");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "compose.yml"), "");

    const result = validateOverlay(join(dir, "compose.yml"));
    expect(result.valid).toBe(false);
  });
});

// ── detectEnvInjectionCollisions ───────────────────────────────────────

describe("detectEnvInjectionCollisions", () => {
  test("detects collision when two instances inject same var into same service", () => {
    const instance1 = join(tempDir, "plugin-a");
    const instance2 = join(tempDir, "plugin-b");
    mkdirSync(instance1, { recursive: true });
    mkdirSync(instance2, { recursive: true });

    writeFileSync(
      join(instance1, "compose.yml"),
      `
services:
  openpalm-plugin-a:
    image: plugin-a:latest
  assistant:
    environment:
      SHARED_URL: http://openpalm-plugin-a:3000
`
    );

    writeFileSync(
      join(instance2, "compose.yml"),
      `
services:
  openpalm-plugin-b:
    image: plugin-b:latest
  assistant:
    environment:
      SHARED_URL: http://openpalm-plugin-b:3000
`
    );

    const collisions = detectEnvInjectionCollisions([
      { id: "plugin-a", dir: instance1 },
      { id: "plugin-b", dir: instance2 },
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].variable).toBe("SHARED_URL");
    expect(collisions[0].targetService).toBe("assistant");
    expect(collisions[0].sources.sort()).toEqual(["plugin-a", "plugin-b"]);
  });

  test("no collision when instances inject different vars", () => {
    const instance1 = join(tempDir, "plugin-a");
    const instance2 = join(tempDir, "plugin-b");
    mkdirSync(instance1, { recursive: true });
    mkdirSync(instance2, { recursive: true });

    writeFileSync(
      join(instance1, "compose.yml"),
      `
services:
  assistant:
    environment:
      PLUGIN_A_URL: http://plugin-a:3000
`
    );

    writeFileSync(
      join(instance2, "compose.yml"),
      `
services:
  assistant:
    environment:
      PLUGIN_B_URL: http://plugin-b:3000
`
    );

    const collisions = detectEnvInjectionCollisions([
      { id: "plugin-a", dir: instance1 },
      { id: "plugin-b", dir: instance2 },
    ]);
    expect(collisions).toHaveLength(0);
  });

  test("no collision when injecting into different core services", () => {
    const instance1 = join(tempDir, "plugin-a");
    const instance2 = join(tempDir, "plugin-b");
    mkdirSync(instance1, { recursive: true });
    mkdirSync(instance2, { recursive: true });

    writeFileSync(
      join(instance1, "compose.yml"),
      `
services:
  assistant:
    environment:
      SHARED_URL: http://plugin-a:3000
`
    );

    writeFileSync(
      join(instance2, "compose.yml"),
      `
services:
  memory:
    environment:
      SHARED_URL: http://plugin-b:3000
`
    );

    const collisions = detectEnvInjectionCollisions([
      { id: "plugin-a", dir: instance1 },
      { id: "plugin-b", dir: instance2 },
    ]);
    expect(collisions).toHaveLength(0);
  });

  test("ignores non-core service environment blocks", () => {
    const instance1 = join(tempDir, "plugin-a");
    const instance2 = join(tempDir, "plugin-b");
    mkdirSync(instance1, { recursive: true });
    mkdirSync(instance2, { recursive: true });

    writeFileSync(
      join(instance1, "compose.yml"),
      `
services:
  openpalm-plugin-a:
    image: plugin-a:latest
    environment:
      MY_VAR: value1
`
    );

    writeFileSync(
      join(instance2, "compose.yml"),
      `
services:
  openpalm-plugin-b:
    image: plugin-b:latest
    environment:
      MY_VAR: value2
`
    );

    const collisions = detectEnvInjectionCollisions([
      { id: "plugin-a", dir: instance1 },
      { id: "plugin-b", dir: instance2 },
    ]);
    expect(collisions).toHaveLength(0);
  });

  test("handles list-style environment entries", () => {
    const instance1 = join(tempDir, "plugin-a");
    const instance2 = join(tempDir, "plugin-b");
    mkdirSync(instance1, { recursive: true });
    mkdirSync(instance2, { recursive: true });

    writeFileSync(
      join(instance1, "compose.yml"),
      `
services:
  assistant:
    environment:
      - SHARED_URL=http://plugin-a:3000
`
    );

    writeFileSync(
      join(instance2, "compose.yml"),
      `
services:
  assistant:
    environment:
      - SHARED_URL=http://plugin-b:3000
`
    );

    const collisions = detectEnvInjectionCollisions([
      { id: "plugin-a", dir: instance1 },
      { id: "plugin-b", dir: instance2 },
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].variable).toBe("SHARED_URL");
  });

  test("handles empty instance list", () => {
    const collisions = detectEnvInjectionCollisions([]);
    expect(collisions).toHaveLength(0);
  });

  test("handles missing compose files gracefully", () => {
    const instance1 = join(tempDir, "missing");
    mkdirSync(instance1, { recursive: true });
    // No compose.yml written

    const collisions = detectEnvInjectionCollisions([
      { id: "missing", dir: instance1 },
    ]);
    expect(collisions).toHaveLength(0);
  });

  test("detects multiple collisions across services", () => {
    const instance1 = join(tempDir, "plugin-a");
    const instance2 = join(tempDir, "plugin-b");
    const instance3 = join(tempDir, "plugin-c");
    mkdirSync(instance1, { recursive: true });
    mkdirSync(instance2, { recursive: true });
    mkdirSync(instance3, { recursive: true });

    writeFileSync(
      join(instance1, "compose.yml"),
      `
services:
  assistant:
    environment:
      OLLAMA_URL: http://ollama:11434
  memory:
    environment:
      OLLAMA_URL: http://ollama:11434
`
    );

    writeFileSync(
      join(instance2, "compose.yml"),
      `
services:
  assistant:
    environment:
      OLLAMA_URL: http://alt-ollama:11434
`
    );

    writeFileSync(
      join(instance3, "compose.yml"),
      `
services:
  memory:
    environment:
      OLLAMA_URL: http://alt-ollama:11434
`
    );

    const collisions = detectEnvInjectionCollisions([
      { id: "plugin-a", dir: instance1 },
      { id: "plugin-b", dir: instance2 },
      { id: "plugin-c", dir: instance3 },
    ]);
    expect(collisions).toHaveLength(2);

    const assistantCollision = collisions.find((c) => c.targetService === "assistant");
    const memoryCollision = collisions.find((c) => c.targetService === "memory");

    expect(assistantCollision).toBeDefined();
    expect(assistantCollision!.sources.sort()).toEqual(["plugin-a", "plugin-b"]);

    expect(memoryCollision).toBeDefined();
    expect(memoryCollision!.sources.sort()).toEqual(["plugin-a", "plugin-c"]);
  });
});
