import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createInstance,
  configureInstance,
  getInstanceDetail,
  listInstances,
  deleteInstance,
  parseEnvSchema,
} from "./instance-lifecycle.js";
import type { ComponentDefinition } from "./components.js";

// ── Test Helpers ───────────────────────────────────────────────────────

let testDir: string;
let openpalmHome: string;
let componentSourceDir: string;

function createTestHome(): string {
  const dir = join(tmpdir(), `openpalm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(dir, "data", "components"), { recursive: true });
  return dir;
}

function createTestComponent(baseDir: string, name: string, options?: {
  schema?: string;
}): ComponentDefinition {
  const srcDir = join(baseDir, "catalog", name);
  mkdirSync(srcDir, { recursive: true });

  // Write compose.yml
  writeFileSync(join(srcDir, "compose.yml"), `services:
  openpalm-\${INSTANCE_ID}:
    image: openpalm/channel-${name}:latest
    container_name: openpalm-\${INSTANCE_ID}
    env_file:
      - \${INSTANCE_DIR}/.env
    volumes:
      - \${INSTANCE_DIR}/data:/state
`);

  // Write .env.schema if provided
  if (options?.schema) {
    writeFileSync(join(srcDir, ".env.schema"), options.schema);
  }

  return {
    id: name,
    sourceDir: srcDir,
    hasCompose: true,
    hasSchema: !!options?.schema,
  };
}

const DISCORD_SCHEMA = `# Discord bot configuration
# ---

# Your bot's token from the Discord Developer Portal.
# https://discord.com/developers/applications
# @required @sensitive
DISCORD_BOT_TOKEN=

# Right-click your server → Copy Server ID.
# @required
DISCORD_GUILD_ID=

# ---

# Behavior
# ---

# Character(s) that prefix bot commands.
DISCORD_PREFIX=!

# Text shown under the bot's name in the member list.
DISCORD_ACTIVITY_MESSAGE=Listening for messages
`;

// ── Setup / Teardown ──────────────────────────────────────────────────

beforeEach(() => {
  openpalmHome = createTestHome();
  componentSourceDir = join(openpalmHome, "catalog");
  mkdirSync(componentSourceDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(openpalmHome, { recursive: true, force: true });
  } catch {
    // cleanup best-effort
  }
});

// ── parseEnvSchema ────────────────────────────────────────────────────

describe("parseEnvSchema", () => {
  it("parses a full schema with sections, defaults, and annotations", () => {
    const schemaPath = join(openpalmHome, "test.env.schema");
    writeFileSync(schemaPath, DISCORD_SCHEMA);

    const fields = parseEnvSchema(schemaPath);

    expect(fields).toHaveLength(4);

    // DISCORD_BOT_TOKEN: @required @sensitive, no default
    const token = fields.find((f) => f.name === "DISCORD_BOT_TOKEN")!;
    expect(token).toBeDefined();
    expect(token.required).toBe(true);
    expect(token.sensitive).toBe(true);
    expect(token.defaultValue).toBe("");
    expect(token.section).toBe("Discord bot configuration");
    expect(token.helpText).toContain("Discord Developer Portal");

    // DISCORD_GUILD_ID: @required, not sensitive, no default
    const guild = fields.find((f) => f.name === "DISCORD_GUILD_ID")!;
    expect(guild).toBeDefined();
    expect(guild.required).toBe(true);
    expect(guild.sensitive).toBe(false);
    expect(guild.defaultValue).toBe("");

    // DISCORD_PREFIX: has default "!"
    const prefix = fields.find((f) => f.name === "DISCORD_PREFIX")!;
    expect(prefix).toBeDefined();
    expect(prefix.required).toBe(false);
    expect(prefix.sensitive).toBe(false);
    expect(prefix.defaultValue).toBe("!");
    expect(prefix.section).toBe("Behavior");

    // DISCORD_ACTIVITY_MESSAGE: has default
    const activity = fields.find((f) => f.name === "DISCORD_ACTIVITY_MESSAGE")!;
    expect(activity).toBeDefined();
    expect(activity.defaultValue).toBe("Listening for messages");
  });

  it("returns empty array for non-existent schema", () => {
    const fields = parseEnvSchema("/nonexistent/.env.schema");
    expect(fields).toEqual([]);
  });

  it("returns empty array for empty schema", () => {
    const schemaPath = join(openpalmHome, "empty.env.schema");
    writeFileSync(schemaPath, "");

    const fields = parseEnvSchema(schemaPath);
    expect(fields).toEqual([]);
  });

  it("handles schema with no sections", () => {
    const schemaPath = join(openpalmHome, "simple.env.schema");
    writeFileSync(schemaPath, "PORT=3000\nHOST=localhost\n");

    const fields = parseEnvSchema(schemaPath);
    expect(fields).toHaveLength(2);
    expect(fields[0].name).toBe("PORT");
    expect(fields[0].defaultValue).toBe("3000");
    expect(fields[0].section).toBe("");
    expect(fields[1].name).toBe("HOST");
    expect(fields[1].defaultValue).toBe("localhost");
  });
});

// ── createInstance ─────────────────────────────────────────────────────

describe("createInstance", () => {
  it("creates an instance with compose, env, schema, and data dir", () => {
    const comp = createTestComponent(openpalmHome, "discord", {
      schema: DISCORD_SCHEMA,
    });

    const result = createInstance(openpalmHome, comp, "discord-main");

    // Instance directory exists
    expect(existsSync(result.instanceDir)).toBe(true);

    // compose.yml copied
    expect(existsSync(result.composePath)).toBe(true);
    const composeContent = readFileSync(result.composePath, "utf-8");
    expect(composeContent).toContain("openpalm-${INSTANCE_ID}");

    // .env written with identity vars
    expect(existsSync(result.envPath)).toBe(true);
    const envContent = readFileSync(result.envPath, "utf-8");
    expect(envContent).toContain("INSTANCE_ID=discord-main");
    expect(envContent).toContain("INSTANCE_DIR=");

    // Non-sensitive defaults seeded
    expect(envContent).toContain("DISCORD_PREFIX=!");
    expect(envContent).toContain("DISCORD_ACTIVITY_MESSAGE=Listening for messages");
    // Sensitive fields should NOT be in defaults
    expect(envContent).not.toContain("DISCORD_BOT_TOKEN=");

    // .env.schema copied
    expect(existsSync(result.schemaPath)).toBe(true);

    // data/ subdirectory created
    expect(existsSync(result.dataDir)).toBe(true);

    // Detail fields
    expect(result.id).toBe("discord-main");
    expect(result.component).toBe("discord");
    expect(result.enabled).toBe(true);
  });

  it("creates an instance without schema", () => {
    const comp = createTestComponent(openpalmHome, "simple");
    const result = createInstance(openpalmHome, comp, "simple-1");

    expect(existsSync(result.composePath)).toBe(true);
    expect(existsSync(result.envPath)).toBe(true);

    const envContent = readFileSync(result.envPath, "utf-8");
    expect(envContent).toContain("INSTANCE_ID=simple-1");
  });

  it("adds the instance to enabled.json", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    createInstance(openpalmHome, comp, "discord-main");

    const enabledPath = join(openpalmHome, "data", "components", "enabled.json");
    expect(existsSync(enabledPath)).toBe(true);

    const data = JSON.parse(readFileSync(enabledPath, "utf-8"));
    expect(data.instances).toHaveLength(1);
    expect(data.instances[0].id).toBe("discord-main");
    expect(data.instances[0].component).toBe("discord");
    expect(data.instances[0].enabled).toBe(true);
  });

  it("throws on invalid instance ID", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    expect(() => createInstance(openpalmHome, comp, "INVALID")).toThrow("Invalid instance ID");
    expect(() => createInstance(openpalmHome, comp, "-bad")).toThrow("Invalid instance ID");
    expect(() => createInstance(openpalmHome, comp, "")).toThrow("Invalid instance ID");
  });

  it("throws on reserved name", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    expect(() => createInstance(openpalmHome, comp, "assistant")).toThrow("reserved");
    expect(() => createInstance(openpalmHome, comp, "guardian")).toThrow("reserved");
    expect(() => createInstance(openpalmHome, comp, "memory")).toThrow("reserved");
    expect(() => createInstance(openpalmHome, comp, "admin")).toThrow("reserved");
    expect(() => createInstance(openpalmHome, comp, "scheduler")).toThrow("reserved");
  });

  it("throws when instance already exists", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    createInstance(openpalmHome, comp, "discord-main");
    expect(() => createInstance(openpalmHome, comp, "discord-main")).toThrow("already exists");
  });

  it("does not seed sensitive default values", () => {
    const schema = `# @required @sensitive
SECRET_KEY=default-secret-value
# Non-sensitive
PUBLIC_KEY=public-value
`;
    const comp = createTestComponent(openpalmHome, "test", { schema });
    const result = createInstance(openpalmHome, comp, "test-1");

    const envContent = readFileSync(result.envPath, "utf-8");
    // Sensitive default should NOT be seeded even if it has a value
    expect(envContent).not.toContain("SECRET_KEY=");
    // Non-sensitive default should be seeded
    expect(envContent).toContain("PUBLIC_KEY=public-value");
  });
});

// ── configureInstance ─────────────────────────────────────────────────

describe("configureInstance", () => {
  it("merges new values into the .env", () => {
    const comp = createTestComponent(openpalmHome, "discord", { schema: DISCORD_SCHEMA });
    createInstance(openpalmHome, comp, "discord-main");

    configureInstance(openpalmHome, "discord-main", {
      DISCORD_GUILD_ID: "123456789",
      DISCORD_PREFIX: "?",
    });

    const envPath = join(openpalmHome, "data", "components", "discord-main", ".env");
    const envContent = readFileSync(envPath, "utf-8");
    expect(envContent).toContain("DISCORD_GUILD_ID=123456789");
    expect(envContent).toContain("DISCORD_PREFIX=?");
  });

  it("preserves INSTANCE_ID and INSTANCE_DIR", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    const result = createInstance(openpalmHome, comp, "discord-main");

    configureInstance(openpalmHome, "discord-main", {
      INSTANCE_ID: "should-be-ignored",
      INSTANCE_DIR: "/should/be/ignored",
      NEW_VAR: "value",
    });

    const envContent = readFileSync(result.envPath, "utf-8");
    expect(envContent).toContain("INSTANCE_ID=discord-main");
    expect(envContent).not.toContain("should-be-ignored");
    expect(envContent).not.toContain("/should/be/ignored");
    expect(envContent).toContain("NEW_VAR=value");
  });

  it("throws if instance does not exist", () => {
    expect(() => configureInstance(openpalmHome, "nonexistent", { KEY: "val" })).toThrow("does not exist");
  });

  it("preserves existing values when adding new ones", () => {
    const comp = createTestComponent(openpalmHome, "discord", { schema: DISCORD_SCHEMA });
    createInstance(openpalmHome, comp, "discord-main");

    // First configure
    configureInstance(openpalmHome, "discord-main", { CUSTOM_A: "valueA" });
    // Second configure
    configureInstance(openpalmHome, "discord-main", { CUSTOM_B: "valueB" });

    const envContent = readFileSync(
      join(openpalmHome, "data", "components", "discord-main", ".env"),
      "utf-8"
    );
    expect(envContent).toContain("CUSTOM_A=valueA");
    expect(envContent).toContain("CUSTOM_B=valueB");
  });

  it("rejects newlines in values to prevent env injection", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    createInstance(openpalmHome, comp, "discord-main");

    expect(() =>
      configureInstance(openpalmHome, "discord-main", { KEY: "value\nINJECTED=true" })
    ).toThrow("Invalid characters");
  });

  it("rejects carriage returns in values", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    createInstance(openpalmHome, comp, "discord-main");

    expect(() =>
      configureInstance(openpalmHome, "discord-main", { KEY: "value\rINJECTED=true" })
    ).toThrow("Invalid characters");
  });

  it("rejects invalid env keys", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    createInstance(openpalmHome, comp, "discord-main");

    expect(() =>
      configureInstance(openpalmHome, "discord-main", { "INVALID KEY": "value" })
    ).toThrow("Invalid env key");
  });

  it("rejects env keys with special characters", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    createInstance(openpalmHome, comp, "discord-main");

    expect(() =>
      configureInstance(openpalmHome, "discord-main", { "KEY=INJECTION": "value" })
    ).toThrow("Invalid env key");

    expect(() =>
      configureInstance(openpalmHome, "discord-main", { "KEY;rm -rf /": "value" })
    ).toThrow("Invalid env key");
  });

  it("rejects env keys starting with a number", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    createInstance(openpalmHome, comp, "discord-main");

    expect(() =>
      configureInstance(openpalmHome, "discord-main", { "1BAD_KEY": "value" })
    ).toThrow("Invalid env key");
  });
});

// ── getInstanceDetail ─────────────────────────────────────────────────

describe("getInstanceDetail", () => {
  it("returns details for an existing instance", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    createInstance(openpalmHome, comp, "discord-main");

    const detail = getInstanceDetail(openpalmHome, "discord-main");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("discord-main");
    expect(detail!.component).toBe("discord");
    expect(detail!.enabled).toBe(true);
  });

  it("returns null for a non-existing instance", () => {
    const detail = getInstanceDetail(openpalmHome, "does-not-exist");
    expect(detail).toBeNull();
  });
});

// ── listInstances ─────────────────────────────────────────────────────

describe("listInstances", () => {
  it("returns empty array when no instances exist", () => {
    const instances = listInstances(openpalmHome);
    expect(instances).toEqual([]);
  });

  it("lists multiple instances", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    createInstance(openpalmHome, comp, "discord-main");
    createInstance(openpalmHome, comp, "discord-gaming");

    const instances = listInstances(openpalmHome);
    expect(instances).toHaveLength(2);

    const ids = instances.map((i) => i.id).sort();
    expect(ids).toEqual(["discord-gaming", "discord-main"]);
  });

  it("includes correct component and enabled status", () => {
    const discordComp = createTestComponent(openpalmHome, "discord");
    const ollamaComp = createTestComponent(openpalmHome, "ollama");

    createInstance(openpalmHome, discordComp, "discord-main");
    createInstance(openpalmHome, ollamaComp, "my-ollama");

    const instances = listInstances(openpalmHome);
    const discord = instances.find((i) => i.id === "discord-main");
    const ollama = instances.find((i) => i.id === "my-ollama");

    expect(discord).toBeDefined();
    expect(discord!.component).toBe("discord");
    expect(discord!.enabled).toBe(true);

    expect(ollama).toBeDefined();
    expect(ollama!.component).toBe("ollama");
    expect(ollama!.enabled).toBe(true);
  });

  it("returns empty when components dir does not exist", () => {
    const emptyHome = createTestHome();
    rmSync(join(emptyHome, "data", "components"), { recursive: true, force: true });

    const instances = listInstances(emptyHome);
    expect(instances).toEqual([]);

    rmSync(emptyHome, { recursive: true, force: true });
  });
});

// ── deleteInstance ─────────────────────────────────────────────────────

describe("deleteInstance", () => {
  it("archives the instance directory", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    createInstance(openpalmHome, comp, "discord-main");

    deleteInstance(openpalmHome, "discord-main");

    // Original directory should be gone
    expect(existsSync(join(openpalmHome, "data", "components", "discord-main"))).toBe(false);

    // Archive directory should exist
    const archDir = join(openpalmHome, "data", "archived");
    expect(existsSync(archDir)).toBe(true);
    const archives = readdirSync(archDir);
    expect(archives.length).toBe(1);
    expect(archives[0]).toMatch(/^discord-main-/);
  });

  it("removes instance from enabled.json", () => {
    const comp = createTestComponent(openpalmHome, "discord");
    createInstance(openpalmHome, comp, "discord-main");
    createInstance(openpalmHome, comp, "discord-gaming");

    deleteInstance(openpalmHome, "discord-main");

    const enabledPath = join(openpalmHome, "data", "components", "enabled.json");
    const data = JSON.parse(readFileSync(enabledPath, "utf-8"));
    expect(data.instances).toHaveLength(1);
    expect(data.instances[0].id).toBe("discord-gaming");
  });

  it("throws if instance does not exist", () => {
    expect(() => deleteInstance(openpalmHome, "nonexistent")).toThrow("does not exist");
  });
});

