/**
 * Tests for GET /admin/config/validate route.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

// Mock validateProposedState to avoid needing the varlock binary
vi.mock("$lib/server/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/server/lifecycle.js")>();
  return {
    ...actual,
    validateProposedState: vi.fn()
  };
});

import { getState, resetState } from "$lib/server/state.js";
import { validateProposedState } from "$lib/server/lifecycle.js";
import { GET } from "./+server.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-validate-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let rootDir = "";
let originalHome: string | undefined;

beforeEach(() => {
  rootDir = makeTempDir();
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState("admin-token");

  const state = getState();
  mkdirSync(state.configDir, { recursive: true });
  mkdirSync(state.vaultDir, { recursive: true });
  mkdirSync(state.dataDir, { recursive: true });
  mkdirSync(state.logsDir, { recursive: true });
});

afterEach(() => {
  vi.resetAllMocks();
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

function makeGetEvent(token = "admin-token"): Parameters<typeof GET>[0] {
  const headers: Record<string, string> = {
    "x-request-id": "req-validate-1"
  };
  if (token) {
    headers["x-admin-token"] = token;
  }
  return {
    request: new Request("http://localhost/admin/config/validate", {
      method: "GET",
      headers
    })
  } as Parameters<typeof GET>[0];
}

describe("GET /admin/config/validate", () => {
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
      errors: ["ERROR: ADMIN_TOKEN is required but not set"],
      warnings: []
    });

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; errors: string[]; warnings: string[] };
    expect(body.ok).toBe(false);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain("ADMIN_TOKEN");
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
