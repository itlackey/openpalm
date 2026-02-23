import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ADMIN_BASE = "http://localhost:8100";
const ADMIN_TOKEN = "dev-admin-token";
const STATE_FILE_HOST = ".dev/data/admin/setup-state.json";

const stackAvailable = await fetch(`${ADMIN_BASE}/health`, { signal: AbortSignal.timeout(2_000) })
  .then(r => r.ok)
  .catch(() => false);

let savedState: string | null = null;

describe.skipIf(!stackAvailable)("contract: setup wizard gate", () => {
  beforeAll(() => {
    if (existsSync(STATE_FILE_HOST)) {
      savedState = readFileSync(STATE_FILE_HOST, "utf8");
    }
  });

  afterAll(() => {
    if (savedState !== null) {
      mkdirSync(dirname(STATE_FILE_HOST), { recursive: true });
      writeFileSync(STATE_FILE_HOST, savedState, "utf8");
    } else if (existsSync(STATE_FILE_HOST)) {
      rmSync(STATE_FILE_HOST);
    }
  });

  describe("first boot (no state file)", () => {
    beforeAll(() => {
      if (existsSync(STATE_FILE_HOST)) rmSync(STATE_FILE_HOST);
    });

    it("returns 200 without requiring auth", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(resp.status).toBe(200);
    });

    it("returns completed: false", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json()) as { completed: boolean };
      expect(body.completed).toBe(false);
    });

    it("returns firstBoot: true", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json()) as { firstBoot: boolean };
      expect(body.firstBoot).toBe(true);
    });

    it("includes step status showing no steps completed", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json()) as { steps: Record<string, boolean> };
      for (const [_step, done] of Object.entries(body.steps)) {
        expect(done).toBe(false);
      }
    });
  });

  describe("after setup is complete", () => {
    beforeAll(() => {
      mkdirSync(dirname(STATE_FILE_HOST), { recursive: true });
      writeFileSync(
        STATE_FILE_HOST,
        JSON.stringify({
          completed: true,
          completedAt: new Date().toISOString(),
          accessScope: "host",
          serviceInstances: { openmemory: "", psql: "", qdrant: "" },
          smallModel: { endpoint: "", modelId: "" },
          steps: {
            welcome: true, accessScope: true, serviceInstances: true,
            healthCheck: true, security: true, channels: true, extensions: false,
          },
          enabledChannels: [],
          installedExtensions: [],
        }),
        "utf8"
      );
    });

    it("returns 401 without auth token (wizard cannot appear)", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(resp.status).toBe(401);
    });

    it("returns 200 with valid auth token", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        headers: { "x-admin-token": ADMIN_TOKEN },
        signal: AbortSignal.timeout(5000),
      });
      expect(resp.status).toBe(200);
    });

    it("returns completed: true with valid auth", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        headers: { "x-admin-token": ADMIN_TOKEN },
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json()) as { completed: boolean };
      expect(body.completed).toBe(true);
    });

    it("returns firstBoot: false with valid auth", async () => {
      const resp = await fetch(`${ADMIN_BASE}/setup/status`, {
        headers: { "x-admin-token": ADMIN_TOKEN },
        signal: AbortSignal.timeout(5000),
      });
      const body = (await resp.json()) as { firstBoot: boolean };
      expect(body.firstBoot).toBe(false);
    });
  });
});
