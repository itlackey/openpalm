/**
 * Tests for GET /api/host/config/validate route.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

// Mock validateProposedState to avoid needing the varlock binary
vi.mock("@openpalm/lib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openpalm/lib")>();
  return {
    ...actual,
    validateProposedState: vi.fn()
  };
});

import { getState } from "$lib/server/state.js";
import { resetState } from "$lib/server/test-helpers.js";
import { validateProposedState } from "@openpalm/lib";
import { GET } from "./+server.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-validate-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = "";
let originalHome: string | undefined;

beforeEach(() => {
  // Phase 4: /api/host + /api/assistant endpoints are capability-guarded;
  // run this suite as a host-capable mode.
  process.env.OP_ENABLE_ADMIN = '1';
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState("admin-token");

  const state = getState();
  mkdirSync(state.configDir, { recursive: true });
  mkdirSync(state.dataDir, { recursive: true });
  mkdirSync(state.stashDir, { recursive: true });
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  vi.resetAllMocks();
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

function makeGetEvent(token = "admin-token"): Parameters<typeof GET>[0] {
  const headers: Record<string, string> = {
    "x-request-id": "req-validate-1"
  };
  // Phase 2: x-admin-token header fallback removed; auth flows via op_session cookie.
  if (token) {
    headers.cookie = `op_session=${token}`;
  }
  return {
    request: new Request("http://localhost/api/host/config/validate", {
      method: "GET",
      headers
    })
  } as Parameters<typeof GET>[0];
}

describe("GET /api/host/config/validate", () => {
  test("returns 200 with { ok: true } when validation succeeds", async () => {
    vi.mocked(validateProposedState).mockResolvedValue({
      ok: true,
      errors: [],
      warnings: []
    });

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; errors: string[]; warnings: string[] };
    expect(body.ok).toBe(true);
    expect(body.errors).toHaveLength(0);
    expect(body.warnings).toHaveLength(0);
  });

  test("returns 200 with { ok: false } when validation finds errors", async () => {
    vi.mocked(validateProposedState).mockResolvedValue({
      ok: false,
      errors: ["ERROR: required secret OP_UI_LOGIN_PASSWORD is missing or empty in private/secrets/op_ui_login_password"],
      warnings: []
    });

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; errors: string[]; warnings: string[] };
    expect(body.ok).toBe(false);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain("OP_UI_LOGIN_PASSWORD");
  });

  test("returns 401 without admin token", async () => {
    const res = await GET(makeGetEvent(""));
    expect(res.status).toBe(401);
  });

  test("returns 401 with wrong admin token", async () => {
    const res = await GET(makeGetEvent("wrong-token"));
    expect(res.status).toBe(401);
  });
});
