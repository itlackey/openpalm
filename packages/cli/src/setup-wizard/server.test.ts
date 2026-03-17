import { describe, expect, it, beforeEach, afterEach } from "bun:test";
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
    secretsSchema: () => "ADMIN_TOKEN=string\n",
    stackSchema: () => "OPENPALM_IMAGE_TAG=string\n",
    cleanupLogs: () => "name: cleanup-logs\nschedule: daily\n",
    cleanupData: () => "name: cleanup-data\nschedule: weekly\n",
    validateConfig: () => "name: validate-config\nschedule: hourly\n",
  };
}

function makeSetupDirs(): void {
  tempBase = mkdtempSync(join(tmpdir(), "openpalm-server-test-"));
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

// ── Test Suites ──────────────────────────────────────────────────────────

// Incrementing port counter to ensure no port conflicts between tests
let nextPort = 19100;

describe("setup wizard server", () => {
  let serverPort: number;

  beforeEach(() => {
    makeSetupDirs();

    savedEnv.OPENPALM_CONFIG_HOME = process.env.OPENPALM_CONFIG_HOME;
    savedEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;
    savedEnv.OPENPALM_STATE_HOME = process.env.OPENPALM_STATE_HOME;
    process.env.OPENPALM_CONFIG_HOME = configDir;
    process.env.OPENPALM_DATA_HOME = dataDir;
    process.env.OPENPALM_STATE_HOME = stateDir;

    // Use incrementing ports to avoid conflicts between sequential tests
    serverPort = nextPort++;
  });

  afterEach(() => {
    process.env.OPENPALM_CONFIG_HOME = savedEnv.OPENPALM_CONFIG_HOME;
    process.env.OPENPALM_DATA_HOME = savedEnv.OPENPALM_DATA_HOME;
    process.env.OPENPALM_STATE_HOME = savedEnv.OPENPALM_STATE_HOME;
    if (tempBase) rmSync(tempBase, { recursive: true, force: true });
  });

  it("serves the wizard HTML at GET /setup", async () => {
    const { server, stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/setup`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("OpenPalm Setup Wizard");
    } finally {
      stop();
    }
  });

  it("serves wizard.js at GET /setup/wizard.js", async () => {
    const { server, stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/setup/wizard.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/javascript");
    } finally {
      stop();
    }
  });

  it("serves wizard.css at GET /setup/wizard.css", async () => {
    const { server, stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/setup/wizard.css`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/css");
    } finally {
      stop();
    }
  });

  it("returns setup status at GET /api/setup/status", async () => {
    const { server, stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/status`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; setupComplete: boolean };
      expect(data.ok).toBe(true);
      expect(data.setupComplete).toBe(false);
    } finally {
      stop();
    }
  });

  it("returns provider detection at GET /api/setup/detect-providers", async () => {
    const { server, stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      // detectLocalProviders probes real network endpoints with 3s timeouts each,
      // so we allow a generous timeout for this test.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`http://localhost:${serverPort}/api/setup/detect-providers`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; providers: unknown[] };
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.providers)).toBe(true);
    } finally {
      stop();
    }
  }, 20000); // Extended test timeout for network probing

  it("returns 404 for unknown routes", async () => {
    const { server, stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/nonexistent`);
      expect(res.status).toBe(404);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toBe("not_found");
    } finally {
      stop();
    }
  });

  it("returns deploy status at GET /api/setup/deploy-status", async () => {
    const { server, stop, updateDeployStatus } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      updateDeployStatus([
        { service: "caddy", status: "pending", label: "Caddy" },
        { service: "memory", status: "pulling", label: "Memory" },
      ]);

      const res = await fetch(`http://localhost:${serverPort}/api/setup/deploy-status`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        ok: boolean;
        setupComplete: boolean;
        deployStatus: Array<{ service: string; status: string; label: string }>;
      };
      expect(data.ok).toBe(true);
      expect(data.deployStatus).toHaveLength(2);
      expect(data.deployStatus[0].service).toBe("caddy");
    } finally {
      stop();
    }
  });

  it("rejects invalid JSON on POST /api/setup/complete", async () => {
    const { server, stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
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

  it("completes setup and resolves waitForComplete", async () => {
    const { server, stop, waitForComplete } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const body = {
        adminToken: "test-admin-token-12345",
        ownerName: "Test",
        ownerEmail: "test@example.com",
        memoryUserId: "test_user",
        ollamaEnabled: false,
        connections: [
          {
            id: "openai-main",
            name: "OpenAI",
            provider: "openai",
            baseUrl: "https://api.openai.com",
            apiKey: "sk-test-key-123",
          },
        ],
        assignments: {
          llm: { connectionId: "openai-main", model: "gpt-4o" },
          embeddings: { connectionId: "openai-main", model: "text-embedding-3-small" },
        },
      };

      // Fire POST and await both the response and the completion signal
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

      // Subsequent POST should return "already complete"
      const res2 = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res2.status).toBe(200);
      const data2 = (await res2.json()) as { ok: boolean; message: string };
      expect(data2.message).toBe("Setup already complete");
    } finally {
      stop();
    }
  });

  it("returns 400 for invalid setup input on POST /api/setup/complete", async () => {
    const { server, stop } = createSetupServer(serverPort, {
      assetProvider: createStubAssetProvider(),
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminToken: "short" }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
    } finally {
      stop();
    }
  });
});
