import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSetupServer } from "./server.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

let tempBase: string;
let homeDir: string;
let configDir: string;
let vaultDir: string;
let dataDir: string;
let logsDir: string;

const savedEnv: Record<string, string | undefined> = {};

/** Seed minimal asset files so performSetup() can read them at OP_HOME. */
function seedRequiredAssets(homeDir: string): void {
  mkdirSync(join(homeDir, "stack"), { recursive: true });
  writeFileSync(join(homeDir, "stack", "core.compose.yml"), "services:\n  assistant:\n    image: assistant:latest\n");
  mkdirSync(join(homeDir, "data", "assistant"), { recursive: true });
  writeFileSync(join(homeDir, "data", "assistant", "opencode.jsonc"), '{"$schema":"https://opencode.ai/config.json"}\n');
  writeFileSync(join(homeDir, "data", "assistant", "AGENTS.md"), "# Agents\n");
  writeFileSync(join(homeDir, "vault", "user", "user.env.schema"), "OP_ADMIN_TOKEN=string\n");
  writeFileSync(join(homeDir, "vault", "stack", "stack.env.schema"), "OP_IMAGE_TAG=string\n");
  mkdirSync(join(homeDir, "config", "automations"), { recursive: true });
  writeFileSync(join(homeDir, "config", "automations", "cleanup-logs.yml"), "name: cleanup-logs\nschedule: daily\n");
  writeFileSync(join(homeDir, "config", "automations", "cleanup-data.yml"), "name: cleanup-data\nschedule: weekly\n");
  writeFileSync(join(homeDir, "config", "automations", "validate-config.yml"), "name: validate-config\nschedule: hourly\n");
}

function makeSetupDirs(): void {
  tempBase = mkdtempSync(join(tmpdir(), "openpalm-server-err-test-"));
  homeDir = tempBase;
  configDir = join(homeDir, "config");
  vaultDir = join(homeDir, "vault");
  dataDir = join(homeDir, "data");
  logsDir = join(homeDir, "logs");

  for (const dir of [
    configDir,
    join(configDir, "components"),
    join(configDir, "connections"),
    join(configDir, "assistant"),
    join(configDir, "automations"),
    vaultDir,
    dataDir,
    join(dataDir, "admin"),
    join(dataDir, "memory"),
    join(dataDir, "assistant"),
    join(dataDir, "guardian"),
    join(dataDir, "stash"),
    join(dataDir, "workspace"),
    logsDir,
    join(logsDir, "opencode"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  mkdirSync(join(vaultDir, "stack"), { recursive: true });
  mkdirSync(join(vaultDir, "user"), { recursive: true });
  writeFileSync(join(vaultDir, "stack", "stack.env"), "OP_SETUP_COMPLETE=false\n");
  writeFileSync(
    join(vaultDir, "user", "user.env"),
    [
      "# OpenPalm Secrets",
      "export OP_ADMIN_TOKEN=",

      "export OPENAI_API_KEY=",
      "export OPENAI_BASE_URL=",
      "export ANTHROPIC_API_KEY=",
      "export GROQ_API_KEY=",
      "export MISTRAL_API_KEY=",
      "export GOOGLE_API_KEY=",
      "export MEMORY_USER_ID=default_user",
      "export OWNER_NAME=",
      "export OWNER_EMAIL=",
      "",
    ].join("\n")
  );

  // Seed asset files for performSetup() reads
  seedRequiredAssets(homeDir);
}

// Incrementing port counter to avoid conflicts
let nextPort = 19200;

describe("setup wizard server error scenarios", () => {
  let serverPort: number;

  beforeEach(() => {
    makeSetupDirs();

    savedEnv.OP_HOME = process.env.OP_HOME;
    process.env.OP_HOME = homeDir;

    serverPort = nextPort++;
  });

  afterEach(() => {
    process.env.OP_HOME = savedEnv.OP_HOME;
    if (tempBase) rmSync(tempBase, { recursive: true, force: true });
  });

  // ── POST /api/setup/complete validation errors ────────────────────────

  it("returns 400 when adminToken is missing", async () => {
    const { stop } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // no security.adminToken
          spec: {
            version: 2,
            capabilities: {
              llm: "openai/gpt-4o",
              embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
              memory: { userId: "user1", customInstructions: "" },
            },
            addons: {},
          },
          connections: [{ id: "c1", name: "C1", provider: "openai", baseUrl: "", apiKey: "sk-test" }],
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toContain("security");
    } finally {
      stop();
    }
  });

  it("returns 400 when connections array is not an array", async () => {
    const { stop } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spec: {
            version: 2,
            capabilities: {
              llm: "openai/gpt-4o",
              embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
              memory: { userId: "user1", customInstructions: "" },
            },
            addons: {},
          },
          security: { adminToken: "valid-token-12345" },
          owner: { name: "Test User", email: "test@example.com" },
          connections: "not-an-array",
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toContain("connections");
    } finally {
      stop();
    }
  });

  it("returns 400 when spec is missing", async () => {
    const { stop } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          security: { adminToken: "valid-token-12345" },
          owner: { name: "Test User", email: "test@example.com" },
          connections: [{ id: "c1", name: "C1", provider: "openai", baseUrl: "", apiKey: "sk-test" }],
          // no spec
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toContain("spec");
    } finally {
      stop();
    }
  });

  it("returns 400 when connection provider does not match embeddings provider", async () => {
    const { stop } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spec: {
            version: 2,
            capabilities: {
              llm: "fakeprovider/gpt-4o",
              embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
              memory: { userId: "user1", customInstructions: "" },
            },
            addons: {},
          },
          security: { adminToken: "valid-token-12345" },
          owner: { name: "Test User", email: "test@example.com" },
          connections: [{ id: "c1", name: "C1", provider: "fakeprovider", baseUrl: "", apiKey: "sk-test" }],
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      // performSetup fails because no connection matches embeddings provider "openai"
      expect(data.error).toContain("embeddings provider");
    } finally {
      stop();
    }
  });

  it("returns 400 when no connection matches LLM provider", async () => {
    const { stop } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spec: {
            version: 2,
            capabilities: {
              llm: "anthropic/claude-3-opus", // No anthropic connection provided
              embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
              memory: { userId: "user1", customInstructions: "" },
            },
            addons: {},
          },
          security: { adminToken: "valid-token-12345" },
          owner: { name: "Test User", email: "test@example.com" },
          connections: [{ id: "c1", name: "C1", provider: "openai", baseUrl: "", apiKey: "sk-test" }],
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toContain("No connection found for LLM provider");
    } finally {
      stop();
    }
  });

  // ── POST /api/setup/models/:provider errors ───────────────────────────

  it("returns 400 for invalid JSON on model fetch", async () => {
    const { stop } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/models/openai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toBe("invalid_json");
    } finally {
      stop();
    }
  });

  // lmstudio fetch to 127.0.0.1:1234 can take >5s to fail when nothing listens
  it("returns empty model list when provider has no base URL", async () => {
    const { stop } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      // lmstudio without a base URL should return 502 with recoverable_error
      const res = await fetch(`http://localhost:${serverPort}/api/setup/models/lmstudio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "", baseUrl: "" }),
      });
      expect(res.status).toBe(502);
      const data = (await res.json()) as { ok: boolean; models: string[]; status: string; reason: string };
      expect(data.ok).toBe(false);
      expect(Array.isArray(data.models)).toBe(true);
      expect(data.status).toBe("recoverable_error");
    } finally {
      stop();
    }
  }, 15000);

  it("returns recoverable error when model fetch hits unreachable server", async () => {
    const { stop } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      // Use a baseUrl that definitely will not connect — should return 502
      const res = await fetch(`http://localhost:${serverPort}/api/setup/models/openai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-fake", baseUrl: "http://127.0.0.1:1" }),
      });
      expect(res.status).toBe(502);
      const data = (await res.json()) as {
        ok: boolean;
        models: string[];
        status: string;
        reason: string;
        error?: string;
      };
      expect(data.ok).toBe(false);
      expect(data.models).toEqual([]);
      expect(data.status).toBe("recoverable_error");
      expect(data.reason).toBe("network");
      expect(data.error).toBeDefined();
    } finally {
      stop();
    }
  }, 10000);

  it("returns static model list for anthropic (no network call needed)", async () => {
    const { stop } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/models/anthropic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-ant-test", baseUrl: "" }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; models: string[]; status: string; reason: string };
      expect(data.ok).toBe(true);
      expect(data.models.length).toBeGreaterThan(0);
      expect(data.status).toBe("ok");
      expect(data.reason).toBe("provider_static");
    } finally {
      stop();
    }
  });

  // ── Deploy status with error state ────────────────────────────────────

  it("reports deploy error via deploy-status endpoint", async () => {
    const { stop, updateDeployStatus, setDeployError } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      updateDeployStatus([
        { service: "assistant", status: "running", label: "Assistant" },
        { service: "memory", status: "error", label: "Failed to pull" },
      ]);
      setDeployError("memory container failed to start");

      const res = await fetch(`http://localhost:${serverPort}/api/setup/deploy-status`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        ok: boolean;
        deployStatus: Array<{ service: string; status: string; label: string }>;
        deployError: string | null;
      };
      expect(data.ok).toBe(true);
      expect(data.deployError).toBe("memory container failed to start");
      const memEntry = data.deployStatus.find((e) => e.service === "memory");
      expect(memEntry?.status).toBe("error");
    } finally {
      stop();
    }
  });

  // ── HTTP method mismatches ────────────────────────────────────────────

  it("returns 404 for GET on model endpoint (requires POST)", async () => {
    const { stop } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/models/openai`);
      expect(res.status).toBe(404);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
    } finally {
      stop();
    }
  });

  it("returns 404 for GET on /api/setup/complete (requires POST)", async () => {
    const { stop } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`);
      expect(res.status).toBe(404);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
    } finally {
      stop();
    }
  });
});
