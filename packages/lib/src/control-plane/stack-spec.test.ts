import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readStackSpec,
  readRawStackSpec,
  writeStackSpec,
  writeStackSpecV3,
  upgradeV3ToV4InMemory,
  type StackSpecV3,
  type StackSpec,
} from "./stack-spec.js";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "op-spec-test-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

// ── v4 Round-trip ─────────────────────────────────────────────────────

describe("writeStackSpec + readStackSpec (v4)", () => {
  test("round-trips a minimal v4 spec", () => {
    const spec: StackSpec = {
      version: 4,
      connections: [{ id: "openai", name: "OpenAI", provider: "openai", baseUrl: "" }],
      assignments: {
        llm: { connectionId: "openai", model: "gpt-4o" },
        embeddings: { connectionId: "openai", model: "text-embedding-3-small", dims: 1536 },
      },
    };
    writeStackSpec(configDir, spec);
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    expect(read!.version).toBe(4);
    expect(read!.connections).toHaveLength(1);
    expect(read!.connections[0].id).toBe("openai");
    expect(read!.assignments.llm.model).toBe("gpt-4o");
    expect(read!.assignments.embeddings.dims).toBe(1536);
  });

  test("round-trips a full v4 spec with all fields", () => {
    const spec: StackSpec = {
      version: 4,
      connections: [
        { id: "openai", name: "OpenAI", provider: "openai", baseUrl: "", kind: "openai_compatible_remote", auth: { mode: "api_key", secretRef: "env:OPENAI_API_KEY" } },
        { id: "ollama", name: "Ollama", provider: "ollama", baseUrl: "http://localhost:11434", kind: "ollama_local", auth: { mode: "none" } },
      ],
      assignments: {
        llm: { connectionId: "openai", model: "gpt-4o", smallModel: "gpt-4o-mini" },
        embeddings: { connectionId: "ollama", model: "nomic-embed-text", dims: 768 },
        reranking: { enabled: true, connectionId: "openai", mode: "llm", model: "gpt-4o-mini" },
        tts: { enabled: true, connectionId: "openai", model: "tts-1", voice: "alloy" },
        stt: { enabled: false },
      },
      features: { ollama: true, admin: true },
      ports: { ingress: 8080, assistant: 4000 },
      network: { bindAddress: "0.0.0.0" },
      image: { namespace: "myrepo", tag: "v1.0" },
      runtime: { uid: 1001, gid: 1001, dockerSock: "/run/docker.sock" },
      memory: { userId: "alice" },
      channels: { chat: true, discord: { enabled: true, name: "Discord" } },
      services: { openviking: true },
      voice: { tts: "kokoro", stt: "whisper-local" },
    };
    writeStackSpec(configDir, spec);
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    expect(read!.version).toBe(4);
    expect(read!.connections).toHaveLength(2);
    expect(read!.features?.ollama).toBe(true);
    expect(read!.ports?.ingress).toBe(8080);
    expect(read!.network?.bindAddress).toBe("0.0.0.0");
    expect(read!.image?.namespace).toBe("myrepo");
    expect(read!.runtime?.uid).toBe(1001);
    expect(read!.memory?.userId).toBe("alice");
    expect(read!.channels?.chat).toBe(true);
    expect(read!.voice?.tts).toBe("kokoro");
  });
});

// ── v3 Auto-Upgrade ──────────────────────────────────────────────────

describe("readStackSpec auto-upgrades v3 to v4", () => {
  test("reads a v3 spec and returns v4", () => {
    const v3: StackSpecV3 = {
      version: 3,
      connections: [{ id: "openai", name: "OpenAI", provider: "openai", baseUrl: "" }],
      assignments: {
        llm: { connectionId: "openai", model: "gpt-4o" },
        embeddings: { connectionId: "openai", model: "text-embedding-3-small", embeddingDims: 1536 },
      },
      ollamaEnabled: true,
      channels: ["chat", "api"],
      services: { admin: true, openviking: false },
    };
    writeStackSpecV3(configDir, v3);
    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    expect(read!.version).toBe(4);
    expect(read!.features?.ollama).toBe(true);
    expect(read!.features?.admin).toBe(true);
    // embeddingDims -> dims rename
    expect(read!.assignments.embeddings.dims).toBe(1536);
    // channels array -> Record
    expect(read!.channels).toEqual({ chat: true, api: true });
    // admin removed from services (moved to features)
    expect(read!.services).toEqual({ openviking: false });
  });

  test("preserves voice settings from v3", () => {
    const v3: StackSpecV3 = {
      version: 3,
      connections: [],
      assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: false,
      voice: { tts: "kokoro", stt: "whisper-local" },
    };
    writeStackSpecV3(configDir, v3);
    const read = readStackSpec(configDir);
    expect(read!.voice).toEqual({ tts: "kokoro", stt: "whisper-local" });
  });
});

// ── readRawStackSpec ─────────────────────────────────────────────────

describe("readRawStackSpec", () => {
  test("returns v3 without upgrading", () => {
    const v3: StackSpecV3 = {
      version: 3,
      connections: [],
      assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: false,
    };
    writeStackSpecV3(configDir, v3);
    const raw = readRawStackSpec(configDir);
    expect(raw).not.toBeNull();
    expect(raw!.version).toBe(3);
  });

  test("returns v4 as-is", () => {
    const v4: StackSpec = {
      version: 4,
      connections: [],
      assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
    };
    writeStackSpec(configDir, v4);
    const raw = readRawStackSpec(configDir);
    expect(raw).not.toBeNull();
    expect(raw!.version).toBe(4);
  });
});

// ── Error Cases ─────────────────────────────────────────────────────

describe("readStackSpec error cases", () => {
  test("returns null for missing file", () => {
    expect(readStackSpec(configDir)).toBeNull();
  });

  test("returns null for empty file", () => {
    writeFileSync(join(configDir, "openpalm.yaml"), "");
    expect(readStackSpec(configDir)).toBeNull();
  });

  test("returns null for corrupt YAML", () => {
    writeFileSync(join(configDir, "openpalm.yaml"), "{{{{not yaml}}}}");
    expect(readStackSpec(configDir)).toBeNull();
  });

  test("returns null for non-object YAML", () => {
    writeFileSync(join(configDir, "openpalm.yaml"), "just a string");
    expect(readStackSpec(configDir)).toBeNull();
  });

  test("returns null for unknown version", () => {
    writeFileSync(join(configDir, "openpalm.yaml"), "version: 99\n");
    expect(readStackSpec(configDir)).toBeNull();
  });

  test("returns null for version 2", () => {
    writeFileSync(join(configDir, "openpalm.yaml"), "version: 2\n");
    expect(readStackSpec(configDir)).toBeNull();
  });
});

// ── .yml Fallback ───────────────────────────────────────────────────

describe("readStackSpec .yml fallback", () => {
  test("reads from openpalm.yml when .yaml missing", () => {
    const v3: StackSpecV3 = {
      version: 3,
      connections: [{ id: "test", name: "Test", provider: "openai", baseUrl: "" }],
      assignments: { llm: { connectionId: "test", model: "gpt-4o" }, embeddings: { connectionId: "test", model: "embed" } },
      ollamaEnabled: false,
    };
    // Write to .yml not .yaml
    const { stringify } = require("yaml");
    writeFileSync(join(configDir, "openpalm.yml"), stringify(v3, { indent: 2 }));

    const read = readStackSpec(configDir);
    expect(read).not.toBeNull();
    expect(read!.version).toBe(4);
    expect(read!.connections[0].id).toBe("test");
  });

  test("prefers .yaml over .yml when both exist", () => {
    const v3yml: StackSpecV3 = {
      version: 3,
      connections: [{ id: "yml-conn", name: "YML", provider: "openai", baseUrl: "" }],
      assignments: { llm: { connectionId: "yml-conn", model: "m" }, embeddings: { connectionId: "yml-conn", model: "e" } },
      ollamaEnabled: false,
    };
    const v4yaml: StackSpec = {
      version: 4,
      connections: [{ id: "yaml-conn", name: "YAML", provider: "openai", baseUrl: "" }],
      assignments: { llm: { connectionId: "yaml-conn", model: "m" }, embeddings: { connectionId: "yaml-conn", model: "e" } },
    };
    const { stringify } = require("yaml");
    writeFileSync(join(configDir, "openpalm.yml"), stringify(v3yml, { indent: 2 }));
    writeStackSpec(configDir, v4yaml);

    const read = readStackSpec(configDir);
    expect(read!.connections[0].id).toBe("yaml-conn");
  });
});

// ── upgradeV3ToV4InMemory ────────────────────────────────────────────

describe("upgradeV3ToV4InMemory", () => {
  test("maps ollamaEnabled to features.ollama", () => {
    const v3: StackSpecV3 = {
      version: 3, connections: [], assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: true,
    };
    const v4 = upgradeV3ToV4InMemory(v3);
    expect(v4.features?.ollama).toBe(true);
  });

  test("maps services.admin to features.admin", () => {
    const v3: StackSpecV3 = {
      version: 3, connections: [], assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: false, services: { admin: true },
    };
    const v4 = upgradeV3ToV4InMemory(v3);
    expect(v4.features?.admin).toBe(true);
    // admin should not be in services anymore
    expect(v4.services?.admin).toBeUndefined();
  });

  test("renames embeddingDims to dims", () => {
    const v3: StackSpecV3 = {
      version: 3, connections: [],
      assignments: {
        llm: { connectionId: "", model: "" },
        embeddings: { connectionId: "", model: "embed", embeddingDims: 768 },
      },
      ollamaEnabled: false,
    };
    const v4 = upgradeV3ToV4InMemory(v3);
    expect(v4.assignments.embeddings.dims).toBe(768);
    expect((v4.assignments.embeddings as Record<string, unknown>).embeddingDims).toBeUndefined();
  });

  test("converts channels array to Record", () => {
    const v3: StackSpecV3 = {
      version: 3, connections: [], assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: false, channels: ["chat", "api", "discord"],
    };
    const v4 = upgradeV3ToV4InMemory(v3);
    expect(v4.channels).toEqual({ chat: true, api: true, discord: true });
  });

  test("handles missing optional fields", () => {
    const v3: StackSpecV3 = {
      version: 3, connections: [], assignments: { llm: { connectionId: "", model: "" }, embeddings: { connectionId: "", model: "" } },
      ollamaEnabled: false,
    };
    const v4 = upgradeV3ToV4InMemory(v3);
    expect(v4.voice).toBeUndefined();
    expect(v4.channels).toBeUndefined();
    expect(v4.services).toBeUndefined();
  });
});
