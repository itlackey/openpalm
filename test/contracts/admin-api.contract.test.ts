import { describe, expect, it } from "bun:test";

const ADMIN_BASE = "http://localhost:8100";
const ADMIN_TOKEN = "dev-admin-token";
const stackAvailable = Bun.env.OPENPALM_INTEGRATION === "1";

function adminFetch(path: string, opts: RequestInit = {}) {
  return fetch(`${ADMIN_BASE}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(5000),
  });
}

function authedFetch(path: string, opts: RequestInit = {}) {
  return adminFetch(path, {
    ...opts,
    headers: { "x-admin-token": ADMIN_TOKEN, ...opts.headers },
  });
}

describe.skipIf(!stackAvailable)("contract: admin API endpoints", () => {
  describe("GET /health", () => {
    it("returns 200 with service identity", async () => {
      const resp = await adminFetch("/health");
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { ok: boolean; service: string };
      expect(body.ok).toBe(true);
      expect(body.service).toBe("admin");
    });
  });

  describe("GET /state (auth required)", () => {
    it("returns 401 without auth token", async () => {
      const resp = await adminFetch("/state");
      expect(resp.status).toBe(401);
    });

    it("returns 200 with valid auth and expected shape", async () => {
      const resp = await authedFetch("/state");
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { ok: boolean; data: Record<string, unknown> };
      expect(body.ok).toBe(true);
      expect(body.data).toBeDefined();
      expect(body.data.setup).toBeDefined();
      expect(body.data.spec).toBeDefined();
    });
  });

  describe("POST /command (auth required)", () => {
    it("returns 401 without auth token", async () => {
      const resp = await adminFetch("/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "service.status" }),
      });
      expect(resp.status).toBe(401);
    });

    it("returns 400 for unknown command type", async () => {
      const resp = await authedFetch("/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "nonexistent.command" }),
      });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("unknown_command");
    });
  });

  describe("GET /secrets (auth required)", () => {
    it("returns 401 without auth token", async () => {
      const resp = await adminFetch("/secrets");
      expect(resp.status).toBe(401);
    });

    it("returns 200 with valid auth", async () => {
      const resp = await authedFetch("/secrets");
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  describe("GET /automations (auth required)", () => {
    it("returns 401 without auth token", async () => {
      const resp = await adminFetch("/automations");
      expect(resp.status).toBe(401);
    });

    it("returns 200 with automations array", async () => {
      const resp = await authedFetch("/automations");
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { automations: unknown[] };
      expect(Array.isArray(body.automations)).toBe(true);
    });
  });
});
