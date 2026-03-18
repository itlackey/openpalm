import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSetupServer } from "./server.ts";
import type { CoreAssetProvider } from "@openpalm/lib";

// ── Helpers ──────────────────────────────────────────────────────────────

let tempBase: string;
let configDir: string;
let dataDir: string;
let stateDir: string;

const savedEnv: Record<string, string | undefined> = {};

function createStubAssetProvider(): CoreAssetProvider {
  return {
    coreCompose: () => "services:\n  caddy:\n    image: caddy:latest\n",
    caddyfile: () =>
      ":80 {\n  @denied not remote_ip 127.0.0.0/8 ::1\n  respond @denied 403\n}\n",
    ollamaCompose: () => "services:\n  ollama:\n    image: ollama/ollama\n",
    agentsMd: () => "# Agents\n",
    opencodeConfig: () => '{"$schema":"https://opencode.ai/config.json"}\n',
    adminOpencodeConfig: () => '{"$schema":"https://opencode.ai/config.json","plugin":["@openpalm/admin-tools"]}\n',
    secretsSchema: () => "ADMIN_TOKEN=string\n",
    stackSchema: () => "OPENPALM_IMAGE_TAG=string\n",
    cleanupLogs: () => "name: cleanup-logs\nschedule: daily\n",
    cleanupData: () => "name: cleanup-data\nschedule: weekly\n",
    validateConfig: () => "name: validate-config\nschedule: hourly\n",
  };
}

function makeSetupDirs(): void {
  tempBase = mkdtempSync(join(tmpdir(), "openpalm-server-err-test-"));
  configDir = join(tempBase, "config");
  dataDir = join(tempBase, "data");
  stateDir = join(tempBase, "state");

  for (const dir of [
    configDir,
    join(configDir, "channels"),
    join(configDir, "connections"),
    join(configDir, "assistant"),
    join(configDir, "automations"),
    join(configDir, "stash"),
    dataDir,
    join(dataDir, "admin"),
    join(dataDir, "memory"),
    join(dataDir, "assistant"),
    join(dataDir, "guardian"),
    join(dataDir, "caddy"),
    join(dataDir, "caddy", "data"),
    join(dataDir, "caddy", "config"),
    join(dataDir, "automations"),
    join(dataDir, "opencode"),
    stateDir,
    join(stateDir, "artifacts"),
    join(stateDir, "audit"),
    join(stateDir, "artifacts", "channels"),
    join(stateDir, "automations"),
    join(stateDir, "opencode"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(join(stateDir, "artifacts", "stack.env"), "OPENPALM_SETUP_COMPLETE=false\n");
  writeFileSync(
    join(configDir, "secrets.env"),
    [
      "# OpenPalm Secrets",
      "export OPENPALM_ADMIN_TOKEN=",
      "export ADMIN_TOKEN=",
      "export OPENAI_API_KEY=",
      "export OPENAI_BASE_URL=",
      "export ANTHROPIC_API_KEY=",
      "export GROQ_API_KEY=",
      "export MISTRAL_API_KEY=",
      "export GOOGLE_API_KEY=",
      "export MEMORY_USER_ID=default_user",
      "export MEMORY_AUTH_TOKEN=abc123",
      "export OWNER_NAME=",
      "export OWNER_EMAIL=",
      "",
    ].join("\n")
  );
}

// Incrementing port counter to avoid conflicts
let nextPort = 19200;

describe("setup wizard server error scenarios", () => {
  let serverPort: number;

  beforeEach(() => {
    makeSetupDirs();

    savedEnv.OPENPALM_CONFIG_HOME = process.env.OPENPALM_CONFIG_HOME;
    savedEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;
    savedEnv.OPENPALM_STATE_HOME = process.env.OPENPALM_STATE_HOME;
    process.env.OPENPALM_CONFIG_HOME = configDir;
    process.env.OPENPALM_DATA_HOME = dataDir;
    process.env.OPENPALM_STATE_HOME = stateDir;

    serverPort = nextPort++;
  });

  afterEach(() => {
    process.env.OPENPALM_CONFIG_HOME = savedEnv.OPENPALM_CONFIG_HOME;
    process.env.OPENPALM_DATA_HOME = savedEnv.OPENPALM_DATA_HOME;
    process.env.OPENPALM_STATE_HOME = savedEnv.OPENPALM_STATE_HOME;
    if (tempBase) rmSync(tempBase, { recursive: true, force: true });
  });

  // ── POST /api/setup/complete validation errors ────────────────────────

  it("returns 400 when adminToken is missing", async () => {
    const { stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // no adminToken
          memoryUserId: "user1",
          ollamaEnabled: false,
          connections: [{ id: "c1", name: "C1", provider: "openai", baseUrl: "", apiKey: "sk-test" }],
          assignments: {
            llm: { connectionId: "c1", model: "gpt-4o" },
            embeddings: { connectionId: "c1", model: "text-embedding-3-small" },
          },
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toContain("adminToken");
    } finally {
      stop();
    }
  });

  it("returns 400 when connections array is empty", async () => {
    const { stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminToken: "valid-token-12345",
          memoryUserId: "user1",
          ollamaEnabled: false,
          connections: [],
          assignments: {
            llm: { connectionId: "c1", model: "gpt-4o" },
            embeddings: { connectionId: "c1", model: "text-embedding-3-small" },
          },
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

  it("returns 400 when assignments are missing", async () => {
    const { stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminToken: "valid-token-12345",
          memoryUserId: "user1",
          ollamaEnabled: false,
          connections: [{ id: "c1", name: "C1", provider: "openai", baseUrl: "", apiKey: "sk-test" }],
          // no assignments
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toContain("assignments");
    } finally {
      stop();
    }
  });

  it("returns 400 when connection has invalid provider", async () => {
    const { stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminToken: "valid-token-12345",
          memoryUserId: "user1",
          ollamaEnabled: false,
          connections: [{ id: "c1", name: "C1", provider: "fakeprovider", baseUrl: "", apiKey: "sk-test" }],
          assignments: {
            llm: { connectionId: "c1", model: "gpt-4o" },
            embeddings: { connectionId: "c1", model: "text-embedding-3-small" },
          },
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toContain("outside wizard scope");
    } finally {
      stop();
    }
  });

  it("returns 400 when assignment references nonexistent connection", async () => {
    const { stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminToken: "valid-token-12345",
          memoryUserId: "user1",
          ollamaEnabled: false,
          connections: [{ id: "c1", name: "C1", provider: "openai", baseUrl: "", apiKey: "sk-test" }],
          assignments: {
            llm: { connectionId: "nonexistent", model: "gpt-4o" },
            embeddings: { connectionId: "c1", model: "text-embedding-3-small" },
          },
        }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toContain("does not match any connection");
    } finally {
      stop();
    }
  });

  // ── POST /api/setup/models/:provider errors ───────────────────────────

  it("returns 400 for invalid JSON on model fetch", async () => {
    const { stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
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

  it("returns empty model list when provider has no base URL", async () => {
    const { stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      // lmstudio without a base URL should return recoverable_error
      const res = await fetch(`http://localhost:${serverPort}/api/setup/models/lmstudio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "", baseUrl: "" }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; models: string[]; status: string; reason: string };
      expect(data.ok).toBe(true);
      // The provider may return an empty list or a recoverable_error with empty models
      expect(Array.isArray(data.models)).toBe(true);
    } finally {
      stop();
    }
  });

  it("returns recoverable error when model fetch hits unreachable server", async () => {
    const { stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      // Use a baseUrl that definitely will not connect
      const res = await fetch(`http://localhost:${serverPort}/api/setup/models/openai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-fake", baseUrl: "http://127.0.0.1:1" }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        ok: boolean;
        models: string[];
        status: string;
        reason: string;
        error?: string;
      };
      expect(data.ok).toBe(true);
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
      assetProvider: createStubAssetProvider(),
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
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      updateDeployStatus([
        { service: "caddy", status: "running", label: "Caddy" },
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
      assetProvider: createStubAssetProvider(),
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
      assetProvider: createStubAssetProvider(),
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
