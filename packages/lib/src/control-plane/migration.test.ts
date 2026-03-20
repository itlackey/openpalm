import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as yamlStringify } from "yaml";
import { migrateV3ToV4 } from "./migration.js";
import { readStackSpec, writeStackSpec, type StackSpec, type StackSpecV3 } from "./stack-spec.js";
import type { ControlPlaneState } from "./types.js";

let homeDir: string;
let configDir: string;
let vaultDir: string;
let dataDir: string;

function makeState(): ControlPlaneState {
  return {
    adminToken: "test-admin-token",
    assistantToken: "test-assistant-token",
    setupToken: "test-setup-token",
    homeDir,
    configDir,
    vaultDir,
    dataDir,
    logsDir: join(homeDir, "logs"),
    cacheDir: join(homeDir, "cache"),
    services: {},
    artifacts: { compose: "", caddyfile: "" },
    artifactMeta: [],
    audit: [],
    channelSecrets: {},
  };
}

function writeV3Spec(spec: StackSpecV3): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "openpalm.yaml"), yamlStringify(spec, { indent: 2 }));
}

function writeSystemEnv(vars: Record<string, string>): void {
  mkdirSync(vaultDir, { recursive: true });
  const content = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(join(vaultDir, "system.env"), content);
}

function writeUserEnv(vars: Record<string, string>): void {
  mkdirSync(vaultDir, { recursive: true });
  const content = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(join(vaultDir, "user.env"), content);
}

function writeProfilesJson(doc: object): void {
  const dir = join(configDir, "connections");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profiles.json"), JSON.stringify(doc));
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "op-migrate-test-"));
  configDir = join(homeDir, "config");
  vaultDir = join(homeDir, "vault");
  dataDir = join(homeDir, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("migrateV3ToV4", () => {
  test("returns immediately when already v4", () => {
    const v4: StackSpec = {
      version: 4,
      connections: [{ id: "test", name: "T", provider: "openai", baseUrl: "" }],
      assignments: { llm: { connectionId: "test", model: "m" }, embeddings: { connectionId: "test", model: "e" } },
    };
    writeStackSpec(configDir, v4);

    const result = migrateV3ToV4(makeState());
    expect(result.ok).toBe(true);
    expect(result.actions).toContain("Already at v4; no migration needed");
  });

  test("upgrades v3 spec to v4", () => {
    writeV3Spec({
      version: 3,
      connections: [{ id: "openai", name: "OpenAI", provider: "openai", baseUrl: "" }],
      assignments: {
        llm: { connectionId: "openai", model: "gpt-4o" },
        embeddings: { connectionId: "openai", model: "embed", embeddingDims: 768 },
      },
      ollamaEnabled: true,
      channels: ["chat"],
    });

    const result = migrateV3ToV4(makeState());
    expect(result.ok).toBe(true);

    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(4);
    expect(spec!.features?.ollama).toBe(true);
    expect(spec!.assignments.embeddings.dims).toBe(768);
    expect(spec!.channels).toEqual({ chat: true });
  });

  test("creates backup of existing openpalm.yaml", () => {
    writeV3Spec({
      version: 3, connections: [], assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: false,
    });

    migrateV3ToV4(makeState());

    expect(existsSync(join(configDir, "openpalm.yaml.v3.bak"))).toBe(true);
  });

  test("does not rename openpalm.yml (non-destructive)", () => {
    writeV3Spec({
      version: 3, connections: [], assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: false,
    });
    // Also create a .yml file
    writeFileSync(join(configDir, "openpalm.yml"), yamlStringify({ ollama: true, admin: false }));

    const result = migrateV3ToV4(makeState());

    // .yml should still exist (not renamed)
    expect(existsSync(join(configDir, "openpalm.yml"))).toBe(true);
    // Should warn about it
    expect(result.warnings.some(w => w.includes("openpalm.yml still exists"))).toBe(true);
  });

  test("merges feature flags from system.env", () => {
    writeV3Spec({
      version: 3, connections: [], assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: false,
    });
    writeSystemEnv({ OPENPALM_OLLAMA_ENABLED: "true", OPENPALM_ADMIN_ENABLED: "true" });

    migrateV3ToV4(makeState());

    const spec = readStackSpec(configDir);
    expect(spec!.features?.ollama).toBe(true);
    expect(spec!.features?.admin).toBe(true);
  });

  test("extracts ports from system.env", () => {
    writeV3Spec({
      version: 3, connections: [], assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: false,
    });
    writeSystemEnv({ OPENPALM_INGRESS_PORT: "8080", OPENPALM_ASSISTANT_PORT: "4000" });

    migrateV3ToV4(makeState());

    const spec = readStackSpec(configDir);
    expect(spec!.ports?.ingress).toBe(8080);
    expect(spec!.ports?.assistant).toBe(4000);
  });

  test("extracts memory userId from user.env", () => {
    writeV3Spec({
      version: 3, connections: [], assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: false,
    });
    writeUserEnv({ MEMORY_USER_ID: "alice" });

    migrateV3ToV4(makeState());

    const spec = readStackSpec(configDir);
    expect(spec!.memory?.userId).toBe("alice");
  });

  test("preserves UID 0 correctly", () => {
    writeV3Spec({
      version: 3, connections: [], assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: false,
    });
    writeSystemEnv({ OPENPALM_UID: "0", OPENPALM_GID: "0" });

    migrateV3ToV4(makeState());

    const spec = readStackSpec(configDir);
    expect(spec!.runtime?.uid).toBe(0);
    expect(spec!.runtime?.gid).toBe(0);
  });

  test("handles no existing config gracefully", () => {
    const result = migrateV3ToV4(makeState());
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => w.includes("No v3 config found"))).toBe(true);
  });

  test("enriches connections from profiles.json", () => {
    writeV3Spec({
      version: 3,
      connections: [{ id: "openai", name: "OpenAI", provider: "openai", baseUrl: "" }],
      assignments: { llm: { connectionId: "openai", model: "gpt-4o" }, embeddings: { connectionId: "openai", model: "embed" } },
      ollamaEnabled: false,
    });
    writeProfilesJson({
      version: 1,
      profiles: [{
        id: "openai", name: "OpenAI Pro", provider: "openai", baseUrl: "https://api.openai.com",
        kind: "openai_compatible_remote",
        auth: { mode: "api_key", apiKeySecretRef: "env:OPENAI_API_KEY" },
      }],
      assignments: {
        llm: { connectionId: "openai", model: "gpt-4o" },
        embeddings: { connectionId: "openai", model: "embed" },
      },
    });

    migrateV3ToV4(makeState());

    const spec = readStackSpec(configDir);
    expect(spec!.connections[0].kind).toBe("openai_compatible_remote");
    expect(spec!.connections[0].auth).toEqual({ mode: "api_key", secretRef: "env:OPENAI_API_KEY" });
  });

  test("handles corrupt profiles.json gracefully", () => {
    writeV3Spec({
      version: 3, connections: [], assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: false,
    });
    const dir = join(configDir, "connections");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "profiles.json"), "not valid json");

    const result = migrateV3ToV4(makeState());
    expect(result.ok).toBe(true);
  });

  test("is idempotent — second run is no-op", () => {
    writeV3Spec({
      version: 3,
      connections: [{ id: "test", name: "T", provider: "openai", baseUrl: "" }],
      assignments: { llm: { connectionId: "test", model: "m" }, embeddings: { connectionId: "test", model: "e" } },
      ollamaEnabled: false,
    });

    const result1 = migrateV3ToV4(makeState());
    expect(result1.ok).toBe(true);

    const result2 = migrateV3ToV4(makeState());
    expect(result2.ok).toBe(true);
    expect(result2.actions).toContain("Already at v4; no migration needed");
  });

  test("builds from profiles.json only when no StackSpec exists", () => {
    // No openpalm.yaml — only profiles.json
    writeProfilesJson({
      version: 1,
      profiles: [{
        id: "ollama", name: "Ollama Local", provider: "ollama",
        baseUrl: "http://localhost:11434",
        kind: "ollama_local",
        auth: { mode: "none" },
      }],
      assignments: {
        llm: { connectionId: "ollama", model: "llama3.2" },
        embeddings: { connectionId: "ollama", model: "nomic-embed-text", embeddingDims: 768 },
      },
    });

    const result = migrateV3ToV4(makeState());
    expect(result.ok).toBe(true);
    expect(result.actions.some(a => a.includes("profiles.json"))).toBe(true);

    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(4);
    expect(spec!.connections).toHaveLength(1);
    expect(spec!.connections[0].id).toBe("ollama");
    expect(spec!.connections[0].kind).toBe("ollama_local");
    expect(spec!.assignments.embeddings.dims).toBe(768);
  });
});
