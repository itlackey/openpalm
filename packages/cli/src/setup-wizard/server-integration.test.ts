/**
 * Server-side integration tests for the setup wizard.
 *
 * These tests exercise the actual HTTP endpoints with real backend behavior:
 * - Model fetching against a running Ollama instance
 * - Full setup completion flow with file artifact verification
 * - Deploy status lifecycle (pending -> running transitions)
 * - Post-completion state transitions
 *
 * Requires: Ollama running on localhost:11434
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSetupServer } from "./server.ts";
import type { CoreAssetProvider } from "@openpalm/lib";

// ── Helpers ──────────────────────────────────────────────────────────────

let tempBase: string;
let homeDir: string;
let configDir: string;
let vaultDir: string;
let dataDir: string;
let logsDir: string;

const savedEnv: Record<string, string | undefined> = {};

function createStubAssetProvider(): CoreAssetProvider {
  return {
    coreCompose: () => "services:\n  caddy:\n    image: caddy:latest\n",
    caddyfile: () =>
      ":80 {\n  @denied not remote_ip 127.0.0.0/8 ::1\n  respond @denied 403\n}\n",
    ollamaCompose: () => "services:\n  ollama:\n    image: ollama/ollama\n",
    adminCompose: () => "services:\n  admin:\n    image: openpalm/admin\n",
    agentsMd: () => "# Agents\n",
    opencodeConfig: () => '{"$schema":"https://opencode.ai/config.json"}\n',
    adminOpencodeConfig: () => '{"$schema":"https://opencode.ai/config.json","plugin":["@openpalm/admin-tools"]}\n',
    secretsSchema: () => "ADMIN_TOKEN=string\n",
    stackSchema: () => "OP_IMAGE_TAG=string\n",
    cleanupLogs: () => "name: cleanup-logs\nschedule: daily\n",
    cleanupData: () => "name: cleanup-data\nschedule: weekly\n",
    validateConfig: () => "name: validate-config\nschedule: hourly\n",
  };
}

function makeSetupDirs(): void {
  tempBase = mkdtempSync(join(tmpdir(), "openpalm-server-integ-test-"));
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
    join(dataDir, "caddy"),
    join(dataDir, "caddy", "data"),
    join(dataDir, "caddy", "channels"),
    join(dataDir, "stash"),
    join(dataDir, "workspace"),
    logsDir,
    join(logsDir, "opencode"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(join(vaultDir, "system.env"), "OP_SETUP_COMPLETE=false\n");
  writeFileSync(
    join(vaultDir, "user.env"),
    [
      "# OpenPalm Secrets",
      "export OP_ADMIN_TOKEN=",
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

/** Check if Ollama is reachable before running integration tests. */
async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Port counter starting above the other test files to avoid conflicts
let nextPort = 19300;

// ── Tests ─────────────────────────────────────────────────────────────────

describe("setup wizard server integration", () => {
  let serverPort: number;
  let ollamaUp: boolean;

  beforeEach(async () => {
    makeSetupDirs();

    savedEnv.OP_HOME = process.env.OP_HOME;
    process.env.OP_HOME = homeDir;

    serverPort = nextPort++;
    ollamaUp = await isOllamaAvailable();
  });

  afterEach(() => {
    process.env.OP_HOME = savedEnv.OP_HOME;
    if (tempBase) rmSync(tempBase, { recursive: true, force: true });
  });

  // ── Model fetching against real Ollama ──────────────────────────────────

  it("fetches real model list from Ollama", async () => {
    if (!ollamaUp) {
      console.log("SKIP: Ollama not available at localhost:11434");
      return;
    }

    const { stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/models/ollama`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "", baseUrl: "http://localhost:11434" }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        ok: boolean;
        models: string[];
        status: string;
        reason: string;
      };
      expect(data.ok).toBe(true);
      expect(data.status).toBe("ok");
      expect(Array.isArray(data.models)).toBe(true);
      expect(data.models.length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  }, 10000);

  it("returns recoverable error for Ollama with empty baseUrl (default is docker-internal)", async () => {
    const { stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      // Ollama default URL is host.docker.internal:11434 (unreachable from host)
      const res = await fetch(`http://localhost:${serverPort}/api/setup/models/ollama`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "", baseUrl: "" }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        models: string[];
        status: string;
        reason: string;
      };
      if (res.status === 200) {
        // Ollama is reachable on this host (e.g. via host.docker.internal)
        expect(data.ok).toBe(true);
        expect(data.status).toBe("ok");
      } else {
        // Ollama default URL unreachable — expect 502
        expect(res.status).toBe(502);
        expect(data.ok).toBe(false);
        expect(data.models).toEqual([]);
        expect(data.status).toBe("recoverable_error");
      }
    } finally {
      stop();
    }
  }, 10000);

  // ── Full setup flow via HTTP ────────────────────────────────────────────

  it("completes full setup with Ollama and verifies file artifacts", async () => {
    if (!ollamaUp) {
      console.log("SKIP: Ollama not available at localhost:11434");
      return;
    }

    const { stop, waitForComplete } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const body = {
        version: 1,
        owner: { name: "Integration Test", email: "integ@test.local" },
        security: { adminToken: "integration-test-token-123" },
        memory: { userId: "integ_user" },
        connections: [
          {
            id: "ollama-local",
            name: "Ollama Local",
            provider: "ollama",
            baseUrl: "http://localhost:11434",
            apiKey: "",
          },
        ],
        assignments: {
          llm: { connectionId: "ollama-local", model: "qwen2.5-coder:3b" },
          embeddings: {
            connectionId: "ollama-local",
            model: "nomic-embed-text",
            embeddingDims: 768,
          },
        },
      };

      const [res, result] = await Promise.all([
        fetch(`http://localhost:${serverPort}/api/setup/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        waitForComplete(),
      ]);

      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(true);
      expect(result.ok).toBe(true);

      // Verify vault/system.env was written with the admin token
      const systemEnvContent = readFileSync(join(vaultDir, "system.env"), "utf-8");
      expect(systemEnvContent).toContain("integration-test-token-123");

      // Verify vault/user.env was written with owner info
      const userEnvContent = readFileSync(join(vaultDir, "user.env"), "utf-8");
      expect(userEnvContent).toContain("OWNER_NAME=Integration Test");

      // Verify memory config was written
      const memConfigPath = join(dataDir, "memory", "default_config.json");
      expect(existsSync(memConfigPath)).toBe(true);
      const memConfig = JSON.parse(readFileSync(memConfigPath, "utf-8"));
      expect(memConfig.mem0.llm.config.model).toBe("qwen2.5-coder:3b");
      expect(memConfig.mem0.embedder.config.model).toBe("nomic-embed-text");
      expect(memConfig.mem0.vector_store.config.embedding_model_dims).toBe(768);

      // Verify connection profiles were written
      const profilesPath = join(configDir, "connections", "profiles.json");
      expect(existsSync(profilesPath)).toBe(true);
      const profiles = JSON.parse(readFileSync(profilesPath, "utf-8"));
      expect(profiles.profiles).toHaveLength(1);
      expect(profiles.profiles[0].provider).toBe("ollama");
      expect(profiles.assignments.llm.model).toBe("qwen2.5-coder:3b");

      // Verify staged compose artifact exists
      const stagedCompose = join(configDir, "components", "core.yml");
      expect(existsSync(stagedCompose)).toBe(true);

      // Verify openpalm.yaml stack spec was written
      const specPath = join(configDir, "openpalm.yaml");
      expect(existsSync(specPath)).toBe(true);
    } finally {
      stop();
    }
  });

  // ── Setup state reflects completion ─────────────────────────────────────

  it("setup status returns true after successful completion", async () => {
    const { stop, waitForComplete } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      // Before setup: should be incomplete
      const beforeRes = await fetch(`http://localhost:${serverPort}/api/setup/status`);
      const beforeData = (await beforeRes.json()) as { ok: boolean; setupComplete: boolean };
      expect(beforeData.setupComplete).toBe(false);

      // Complete setup
      const body = {
        version: 1,
        security: { adminToken: "status-test-token-123" },
        memory: { userId: "status_user" },
        connections: [
          {
            id: "openai-test",
            name: "OpenAI",
            provider: "openai",
            baseUrl: "https://api.openai.com",
            apiKey: "sk-test-key-status",
          },
        ],
        assignments: {
          llm: { connectionId: "openai-test", model: "gpt-4o" },
          embeddings: { connectionId: "openai-test", model: "text-embedding-3-small" },
        },
      };

      await Promise.all([
        fetch(`http://localhost:${serverPort}/api/setup/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        waitForComplete(),
      ]);

      // After setup: should be complete
      const afterRes = await fetch(`http://localhost:${serverPort}/api/setup/status`);
      const afterData = (await afterRes.json()) as { ok: boolean; setupComplete: boolean };
      expect(afterData.setupComplete).toBe(true);
    } finally {
      stop();
    }
  });

  // ── Deploy status lifecycle ─────────────────────────────────────────────

  it("deploy status transitions through pending -> running via markAllRunning", async () => {
    const { stop, updateDeployStatus, markAllRunning } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      // Initially empty
      const emptyRes = await fetch(`http://localhost:${serverPort}/api/setup/deploy-status`);
      const emptyData = (await emptyRes.json()) as {
        ok: boolean;
        deployStatus: Array<{ service: string; status: string }>;
      };
      expect(emptyData.deployStatus).toHaveLength(0);

      // Set to pending
      updateDeployStatus([
        { service: "caddy", status: "pending", label: "Caddy" },
        { service: "memory", status: "pending", label: "Memory" },
        { service: "assistant", status: "pending", label: "Assistant" },
      ]);

      const pendingRes = await fetch(`http://localhost:${serverPort}/api/setup/deploy-status`);
      const pendingData = (await pendingRes.json()) as {
        ok: boolean;
        deployStatus: Array<{ service: string; status: string }>;
      };
      expect(pendingData.deployStatus).toHaveLength(3);
      expect(pendingData.deployStatus.every((e) => e.status === "pending")).toBe(true);

      // Transition to running
      markAllRunning();

      const runningRes = await fetch(`http://localhost:${serverPort}/api/setup/deploy-status`);
      const runningData = (await runningRes.json()) as {
        ok: boolean;
        deployStatus: Array<{ service: string; status: string }>;
      };
      expect(runningData.deployStatus.every((e) => e.status === "running")).toBe(true);
    } finally {
      stop();
    }
  });

  it("markAllRunning preserves error status entries", async () => {
    const { stop, updateDeployStatus, markAllRunning } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      updateDeployStatus([
        { service: "caddy", status: "pulling", label: "Caddy" },
        { service: "memory", status: "error", label: "Memory" },
      ]);

      markAllRunning();

      const res = await fetch(`http://localhost:${serverPort}/api/setup/deploy-status`);
      const data = (await res.json()) as {
        ok: boolean;
        deployStatus: Array<{ service: string; status: string }>;
      };

      const caddy = data.deployStatus.find((e) => e.service === "caddy");
      const memory = data.deployStatus.find((e) => e.service === "memory");
      expect(caddy?.status).toBe("running");
      expect(memory?.status).toBe("error"); // Error entries stay as-is
    } finally {
      stop();
    }
  });

  // ── Setup retry after deploy error ──────────────────────────────────────

  it("allows re-completing setup after a deploy error", async () => {
    const { stop, waitForComplete, setDeployError } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const body = {
        version: 1,
        security: { adminToken: "retry-test-token-123" },
        memory: { userId: "retry_user" },
        connections: [
          {
            id: "openai-retry",
            name: "OpenAI",
            provider: "openai",
            baseUrl: "https://api.openai.com",
            apiKey: "sk-test-key-retry",
          },
        ],
        assignments: {
          llm: { connectionId: "openai-retry", model: "gpt-4o" },
          embeddings: { connectionId: "openai-retry", model: "text-embedding-3-small" },
        },
      };

      // First setup completes successfully
      await Promise.all([
        fetch(`http://localhost:${serverPort}/api/setup/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        waitForComplete(),
      ]);

      // Simulate deploy error
      setDeployError("caddy failed to start");

      // Retry should be allowed (not blocked by "already complete")
      const retryRes = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(retryRes.status).toBe(200);
      const retryData = (await retryRes.json()) as { ok: boolean };
      expect(retryData.ok).toBe(true);
    } finally {
      stop();
    }
  });

  // ── Provider detection integration ──────────────────────────────────────

  it("detect-providers finds Ollama when it is running", async () => {
    if (!ollamaUp) {
      console.log("SKIP: Ollama not available at localhost:11434");
      return;
    }

    const { stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/detect-providers`, {
        signal: AbortSignal.timeout(15000),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        ok: boolean;
        providers: Array<{ provider: string; url: string; available: boolean }>;
      };
      expect(data.ok).toBe(true);

      const ollama = data.providers.find((p) => p.provider === "ollama");
      expect(ollama).toBeDefined();
      expect(ollama!.available).toBe(true);
    } finally {
      stop();
    }
  }, 20000);
});
