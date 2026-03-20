import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration tests for the scheduler HTTP API.
 *
 * These tests start the server in a subprocess and make real HTTP requests
 * to validate the API surface.
 */

const TEST_DIR = join(tmpdir(), `scheduler-server-test-${Date.now()}`);
const AUTOMATIONS_DIR = join(TEST_DIR, "config", "automations");
const PORT = 18090 + Math.floor(Math.random() * 1000);
const BASE_URL = `http://localhost:${PORT}`;
const ADMIN_TOKEN = "test-server-token";

const VALID_SHELL_AUTOMATION = `
name: server-test
description: Test shell automation for server
schedule: "0 0 * * *"
enabled: true
action:
  type: shell
  command:
    - echo
    - hello
on_failure: log
`;

let serverProc: ReturnType<typeof Bun.spawn> | null = null;

async function waitForServer(url: string, maxMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const resp = await fetch(`${url}/health`);
      if (resp.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not start within ${maxMs}ms`);
}

beforeAll(async () => {
  mkdirSync(AUTOMATIONS_DIR, { recursive: true });
  writeFileSync(join(AUTOMATIONS_DIR, "server-test.yml"), VALID_SHELL_AUTOMATION);

  serverProc = Bun.spawn(["bun", "run", join(__dirname, "server.ts")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      OPENPALM_HOME: TEST_DIR,
      OPENPALM_ADMIN_TOKEN: ADMIN_TOKEN,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  await waitForServer(BASE_URL);
});

afterAll(() => {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("scheduler HTTP API", () => {
  describe("GET /health", () => {
    it("should return 200 with status ok", async () => {
      const resp = await fetch(`${BASE_URL}/health`);
      expect(resp.status).toBe(200);

      const body = await resp.json();
      expect(body.status).toBe("ok");
      expect(body.service).toBe("scheduler");
      expect(typeof body.jobCount).toBe("number");
      expect(typeof body.uptime).toBe("number");
    });
  });

  describe("GET /automations", () => {
    it("should require auth", async () => {
      const resp = await fetch(`${BASE_URL}/automations`);
      expect(resp.status).toBe(401);
    });

    it("should list loaded automations", async () => {
      const resp = await fetch(`${BASE_URL}/automations`, {
        headers: { "x-admin-token": ADMIN_TOKEN },
      });
      expect(resp.status).toBe(200);

      const body = await resp.json();
      expect(body.automations).toBeArray();
      expect(body.automations.length).toBeGreaterThanOrEqual(1);

      const auto = body.automations.find(
        (a: { fileName: string }) => a.fileName === "server-test.yml",
      );
      expect(auto).toBeTruthy();
      expect(auto.name).toBe("server-test");
      expect(auto.action.type).toBe("shell");
    });

    it("should include scheduler status", async () => {
      const resp = await fetch(`${BASE_URL}/automations`, {
        headers: { "x-admin-token": ADMIN_TOKEN },
      });
      const body = await resp.json();
      expect(body.scheduler).toBeTruthy();
      expect(typeof body.scheduler.jobCount).toBe("number");
    });
  });

  describe("GET /automations/:name/log", () => {
    it("should return logs for a known automation", async () => {
      const resp = await fetch(`${BASE_URL}/automations/server-test.yml/log`, {
        headers: { "x-admin-token": ADMIN_TOKEN },
      });
      expect(resp.status).toBe(200);

      const body = await resp.json();
      expect(body.fileName).toBe("server-test.yml");
      expect(body.logs).toBeArray();
    });

    it("should return empty logs for unknown automation", async () => {
      const resp = await fetch(`${BASE_URL}/automations/unknown.yml/log`, {
        headers: { "x-admin-token": ADMIN_TOKEN },
      });
      expect(resp.status).toBe(200);

      const body = await resp.json();
      expect(body.logs).toEqual([]);
    });
  });

  describe("POST /automations/:name/run", () => {
    it("should require auth token", async () => {
      const resp = await fetch(`${BASE_URL}/automations/server-test.yml/run`, {
        method: "POST",
      });
      expect(resp.status).toBe(401);
    });

    it("should trigger automation with valid token", async () => {
      const resp = await fetch(`${BASE_URL}/automations/server-test.yml/run`, {
        method: "POST",
        headers: { "x-admin-token": ADMIN_TOKEN },
      });
      expect(resp.status).toBe(200);

      const body = await resp.json();
      expect(body.ok).toBe(true);
    });

    it("should return 404 for unknown automation", async () => {
      const resp = await fetch(`${BASE_URL}/automations/nonexistent.yml/run`, {
        method: "POST",
        headers: { "x-admin-token": ADMIN_TOKEN },
      });
      expect(resp.status).toBe(404);
    });
  });

  describe("unknown routes", () => {
    it("should return 404 for unknown paths", async () => {
      const resp = await fetch(`${BASE_URL}/unknown`);
      expect(resp.status).toBe(404);
    });
  });
});
