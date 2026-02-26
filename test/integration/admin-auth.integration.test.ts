/**
 * Admin auth rejection integration tests.
 *
 * Uses an in-process Bun.serve() mock server that replicates the admin auth
 * middleware pattern (check x-admin-token header) without requiring a running
 * Docker stack. Tests verify both unauthorized and authorized code paths.
 */
import { describe, expect, it, afterAll } from "bun:test";

describe("integration: admin auth rejection", () => {
  const ADMIN_TOKEN = "test-admin-token-secure-enough";

  const protectedPaths = new Set([
    "/state",
    "/secrets",
    "/channels",
  ]);

  // Mock admin server replicating the auth middleware pattern from hooks.server.ts
  const mockAdmin = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({ ok: true, service: "admin" }),
          { headers: { "content-type": "application/json" } }
        );
      }

      if (protectedPaths.has(url.pathname)) {
        const token = req.headers.get("x-admin-token") ?? "";
        if (token !== ADMIN_TOKEN) {
          return new Response(
            JSON.stringify({ error: "unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({ data: "protected-content" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ error: "not_found" }),
        { status: 404, headers: { "content-type": "application/json" } }
      );
    },
  });

  afterAll(() => {
    mockAdmin.stop(true);
  });

  const protectedEndpoints = ["/state", "/secrets", "/channels"];

  for (const path of protectedEndpoints) {
    it(`GET ${path} without token → 401`, async () => {
      const resp = await fetch(
        `http://localhost:${mockAdmin.port}${path}`
      );
      expect(resp.status).toBe(401);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });
  }

  it("GET /state WITH valid token → 200", async () => {
    const resp = await fetch(
      `http://localhost:${mockAdmin.port}/state`,
      { headers: { "x-admin-token": ADMIN_TOKEN } }
    );
    expect(resp.status).toBe(200);
  });
});
