import { describe, expect, it, beforeEach, afterEach } from "bun:test";
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
  tempBase = mkdtempSync(join(tmpdir(), "openpalm-server-test-"));
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

// ── Test Suites ──────────────────────────────────────────────────────────

// Incrementing port counter to ensure no port conflicts between tests
let nextPort = 19100;

describe("setup wizard server", () => {
  let serverPort: number;

  beforeEach(() => {
    makeSetupDirs();

    savedEnv.OP_HOME = process.env.OP_HOME;
    process.env.OP_HOME = homeDir;

    // Use incrementing ports to avoid conflicts between sequential tests
    serverPort = nextPort++;
  });

  afterEach(() => {
    process.env.OP_HOME = savedEnv.OP_HOME;
    if (tempBase) rmSync(tempBase, { recursive: true, force: true });
  });

  it("serves the wizard HTML at GET /setup", async () => {
    const { server, stop } = createSetupServer(serverPort, {
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
      configDir,
    });

    try {
      updateDeployStatus([
        { service: "memory", status: "pending", label: "Memory" },
        { service: "assistant", status: "pulling", label: "Assistant" },
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
      expect(data.deployStatus[0].service).toBe("memory");
    } finally {
      stop();
    }
  });

  it("rejects invalid JSON on POST /api/setup/complete", async () => {
    const { server, stop } = createSetupServer(serverPort, {
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
              userId: "test_user",
              customInstructions: "",
            },
          },
        },
        security: { adminToken: "test-admin-token-12345" },
        owner: { name: "Test", email: "test@example.com" },
        connections: [
          {
            id: "openai-main",
            name: "OpenAI",
            provider: "openai",
            baseUrl: "https://api.openai.com",
            apiKey: "sk-test-key-123",
          },
        ],
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
      configDir,
    });

    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ security: { adminToken: "short" } }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
    } finally {
      stop();
    }
  });
});

// ── OpenCode Provider Routes ──────────────────────────────────────────────

describe("setup wizard OpenCode routes", () => {
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

  it("returns available:false when no openCodeClient provided", async () => {
    const { stop } = createSetupServer(serverPort, { configDir });
    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/opencode/status`);
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; available: boolean };
      expect(data.available).toBe(false);
    } finally {
      stop();
    }
  });

  it("returns empty providers when no openCodeClient provided", async () => {
    const { stop } = createSetupServer(serverPort, { configDir });
    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/opencode/providers`);
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; available: boolean; providers: unknown[] };
      expect(data.available).toBe(false);
      expect(data.providers).toEqual([]);
    } finally {
      stop();
    }
  });

  it("returns 503 for proxy routes when no openCodeClient provided", async () => {
    const { stop } = createSetupServer(serverPort, { configDir });
    try {
      const res = await fetch(`http://localhost:${serverPort}/api/setup/opencode/auth/openai`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "api", key: "sk-test" }),
      });
      expect(res.status).toBe(503);
    } finally {
      stop();
    }
  });

  it("returns available:true when openCodeClient is provided and reachable", async () => {
    // Start a mock OpenCode server
    const mockOC = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/provider") {
          return new Response(JSON.stringify({ all: [{ id: "openai", name: "OpenAI" }] }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/provider/auth") {
          return new Response(JSON.stringify({ openai: [{ type: "api", label: "API Key" }] }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const { createOpenCodeClient } = await import("@openpalm/lib");
    const ocClient = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${mockOC.port}` });
    const { stop } = createSetupServer(serverPort, { configDir, openCodeClient: ocClient });

    try {
      // Status should report available
      const statusRes = await fetch(`http://localhost:${serverPort}/api/setup/opencode/status`);
      const statusData = await statusRes.json() as { ok: boolean; available: boolean };
      expect(statusData.available).toBe(true);

      // Providers should return data
      const provRes = await fetch(`http://localhost:${serverPort}/api/setup/opencode/providers`);
      const provData = await provRes.json() as { ok: boolean; available: boolean; providers: unknown[]; auth: Record<string, unknown> };
      expect(provData.available).toBe(true);
      expect(provData.providers.length).toBeGreaterThan(0);
      expect(provData.auth).toBeDefined();

      // Proxy should forward to mock OpenCode
      const proxyRes = await fetch(`http://localhost:${serverPort}/api/setup/opencode/auth/openai`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "api", key: "sk-test" }),
      });
      expect(proxyRes.status).toBe(200);
    } finally {
      stop();
      mockOC.stop(true);
    }
  });

  it("proxies OAuth callback without timeout (blocks until auth completes)", async () => {
    // Simulate OpenCode's OAuth flow:
    // 1. POST /provider/:id/oauth/authorize → returns URL + instructions
    // 2. POST /provider/:id/oauth/callback → blocks until auth completes, then returns true
    let authComplete = false;

    const mockOC = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/provider") {
          return new Response(JSON.stringify({ all: [{ id: "test-provider", name: "Test" }] }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.pathname === "/provider/test-provider/oauth/authorize") {
          return new Response(JSON.stringify({
            url: "https://example.com/auth",
            method: "manual",
            instructions: "Enter code: TEST-1234",
          }), { headers: { "Content-Type": "application/json" } });
        }

        if (url.pathname === "/provider/test-provider/oauth/callback") {
          // Block until auth is "completed" (simulates device code exchange)
          while (!authComplete) {
            await new Promise(r => setTimeout(r, 100));
          }
          return new Response(JSON.stringify(true), {
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const { createOpenCodeClient } = await import("@openpalm/lib");
    const ocClient = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${mockOC.port}` });
    const { stop } = createSetupServer(serverPort, { configDir, openCodeClient: ocClient });

    try {
      // Step 1: Authorize
      const authRes = await fetch(`http://localhost:${serverPort}/api/setup/opencode/provider/test-provider/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: 0 }),
      });
      expect(authRes.status).toBe(200);
      const authData = await authRes.json() as { url: string; instructions: string };
      expect(authData.url).toBe("https://example.com/auth");
      expect(authData.instructions).toContain("TEST-1234");

      // Step 2: Start callback request (will block until auth completes)
      const callbackPromise = fetch(`http://localhost:${serverPort}/api/setup/opencode/provider/test-provider/oauth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: 0 }),
      });

      // Simulate user completing auth after 500ms
      setTimeout(() => { authComplete = true; }, 500);

      // The callback should complete after auth is done (not timeout at 5s)
      const callbackRes = await callbackPromise;
      expect(callbackRes.status).toBe(200);
      const callbackData = await callbackRes.json();
      expect(callbackData).toBe(true);
    } finally {
      authComplete = true; // ensure mock server unblocks
      stop();
      mockOC.stop(true);
    }
  });
});
