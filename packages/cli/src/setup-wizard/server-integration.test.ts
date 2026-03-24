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
import { STACK_SPEC_FILENAME } from "@openpalm/lib";

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
    join(dataDir, "stash"),
    join(dataDir, "workspace"),
    logsDir,
    join(logsDir, "opencode"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  mkdirSync(join(vaultDir, "stack"), { recursive: true });
  mkdirSync(join(vaultDir, "user"), { recursive: true });
  writeFileSync(
    join(vaultDir, "stack", "stack.env"),
    [
      "OP_SETUP_COMPLETE=false",
      "OP_ADMIN_TOKEN=",
      "OPENAI_API_KEY=",
      "OPENAI_BASE_URL=",
      "ANTHROPIC_API_KEY=",
      "GROQ_API_KEY=",
      "MISTRAL_API_KEY=",
      "GOOGLE_API_KEY=",
      "OWNER_NAME=",
      "OWNER_EMAIL=",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(vaultDir, "user", "user.env"),
    [
      "# OpenPalm — User Extensions",
      "# Add any custom environment variables here.",
      "# These are loaded by compose alongside stack.env.",
      "",
    ].join("\n")
  );

  // Seed asset files for performSetup() reads
  seedRequiredAssets(homeDir);
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
      configDir,
    });

    try {
      const body = {
        spec: {
          version: 2,
          capabilities: {
            llm: "ollama/qwen2.5-coder:3b",
            embeddings: {
              provider: "ollama",
              model: "nomic-embed-text",
              dims: 768,
            },
            memory: {
              userId: "integ_user",
              customInstructions: "",
            },
          },
          addons: {},
        },
        security: { adminToken: "integration-test-token-123" },
        owner: { name: "Integration Test", email: "integ@test.local" },
        connections: [
          {
            id: "ollama-local",
            name: "Ollama Local",
            provider: "ollama",
            baseUrl: "http://localhost:11434",
            apiKey: "",
          },
        ],
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

      // Verify vault/stack/stack.env was written with the admin token
      const systemEnvContent = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
      expect(systemEnvContent).toContain("integration-test-token-123");

      // Verify vault/stack/stack.env was written with owner info (now in stack.env, not user.env)
      expect(systemEnvContent).toContain("OWNER_NAME=Integration Test");

      // Verify OP_CAP_* vars were written to stack.env (replaces managed.env)
      expect(systemEnvContent).toContain("OP_CAP_LLM_MODEL=qwen2.5-coder:3b");
      expect(systemEnvContent).toContain("OP_CAP_EMBEDDINGS_MODEL=nomic-embed-text");
      expect(systemEnvContent).toContain("OP_CAP_EMBEDDINGS_DIMS=768");

      // Verify stack spec was written
      const specPath = join(configDir, STACK_SPEC_FILENAME);
      expect(existsSync(specPath)).toBe(true);

      // Verify core compose artifact exists in stack/
      const stagedCompose = join(homeDir, "stack", "core.compose.yml");
      expect(existsSync(stagedCompose)).toBe(true);
    } finally {
      stop();
    }
  });

  // ── Setup state reflects completion ─────────────────────────────────────

  it("setup status returns true after successful completion", async () => {
    const { stop, waitForComplete } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      // Before setup: should be incomplete
      const beforeRes = await fetch(`http://localhost:${serverPort}/api/setup/status`);
      const beforeData = (await beforeRes.json()) as { ok: boolean; setupComplete: boolean };
      expect(beforeData.setupComplete).toBe(false);

      // Complete setup
      const body = {
        spec: {
          version: 2,
          capabilities: {
            llm: "openai/gpt-4o",
            embeddings: {
              provider: "openai",
              model: "text-embedding-3-small",
              dims: 1536,
            },
            memory: {
              userId: "status_user",
              customInstructions: "",
            },
          },
          addons: {},
        },
        security: { adminToken: "status-test-token-123" },
        owner: { name: "Status Test", email: "status@test.local" },
        connections: [
          {
            id: "openai-test",
            name: "OpenAI",
            provider: "openai",
            baseUrl: "https://api.openai.com",
            apiKey: "sk-test-key-status",
          },
        ],
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
        { service: "memory", status: "pending", label: "Memory" },
        { service: "assistant", status: "pending", label: "Assistant" },
        { service: "guardian", status: "pending", label: "Guardian" },
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
      configDir,
    });

    try {
      updateDeployStatus([
        { service: "assistant", status: "pulling", label: "Assistant" },
        { service: "memory", status: "error", label: "Memory" },
      ]);

      markAllRunning();

      const res = await fetch(`http://localhost:${serverPort}/api/setup/deploy-status`);
      const data = (await res.json()) as {
        ok: boolean;
        deployStatus: Array<{ service: string; status: string }>;
      };

      const assistant = data.deployStatus.find((e) => e.service === "assistant");
      const memory = data.deployStatus.find((e) => e.service === "memory");
      expect(assistant?.status).toBe("running");
      expect(memory?.status).toBe("error"); // Error entries stay as-is
    } finally {
      stop();
    }
  });

  // ── Setup retry after deploy error ──────────────────────────────────────

  it("allows re-completing setup after a deploy error", async () => {
    const { stop, waitForComplete, setDeployError } = createSetupServer(serverPort, {
      configDir,
    });

    try {
      const body = {
        spec: {
          version: 2,
          capabilities: {
            llm: "openai/gpt-4o",
            embeddings: {
              provider: "openai",
              model: "text-embedding-3-small",
              dims: 1536,
            },
            memory: {
              userId: "retry_user",
              customInstructions: "",
            },
          },
          addons: {},
        },
        security: { adminToken: "retry-test-token-123" },
        owner: { name: "Retry Test", email: "retry@test.local" },
        connections: [
          {
            id: "openai-retry",
            name: "OpenAI",
            provider: "openai",
            baseUrl: "https://api.openai.com",
            apiKey: "sk-test-key-retry",
          },
        ],
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
      setDeployError("assistant failed to start");

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
