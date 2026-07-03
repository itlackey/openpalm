/**
 * Admin authorization gate.
 *
 * Exercises handleAdminRequest's Bearer-token check (which now uses the shared
 * constant-time compare): the correct token is accepted, wrong/empty tokens are
 * rejected 401, and an unconfigured (empty) admin token denies all requests
 * fail-closed. Uses a GET /admin/principals request since it needs no body.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAdminRequest } from "./admin.ts";

const ADMIN_TOKEN = "admin-secret-token-abcdef";

let tmpDir: string;
let tokenPath: string;
let emptyPath: string;
const savedTokenFileEnv = Bun.env.GUARDIAN_ADMIN_TOKEN_FILE;

function adminReq(token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://localhost/admin/principals", { method: "GET", headers });
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "guardian-admin-test-"));
  tokenPath = join(tmpDir, "admin-token");
  emptyPath = join(tmpDir, "missing-token"); // never created → reads as ""
  writeFileSync(tokenPath, `${ADMIN_TOKEN}\n`);
});

afterAll(() => {
  if (savedTokenFileEnv === undefined) delete Bun.env.GUARDIAN_ADMIN_TOKEN_FILE;
  else Bun.env.GUARDIAN_ADMIN_TOKEN_FILE = savedTokenFileEnv;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("admin authorize", () => {
  it("accepts the correct Bearer token", async () => {
    Bun.env.GUARDIAN_ADMIN_TOKEN_FILE = tokenPath;
    const resp = await handleAdminRequest(adminReq(ADMIN_TOKEN), "rid-ok");
    expect(resp.status).toBe(200);
  });

  it("rejects a wrong token with 401", async () => {
    Bun.env.GUARDIAN_ADMIN_TOKEN_FILE = tokenPath;
    const resp = await handleAdminRequest(adminReq("not-the-token"), "rid-wrong");
    expect(resp.status).toBe(401);
    expect(((await resp.json()) as { error: string }).error).toBe("unauthorized");
  });

  it("rejects an empty/absent token with 401", async () => {
    Bun.env.GUARDIAN_ADMIN_TOKEN_FILE = tokenPath;
    expect((await handleAdminRequest(adminReq(""), "rid-empty")).status).toBe(401);
    expect((await handleAdminRequest(adminReq(), "rid-none")).status).toBe(401);
  });

  it("denies all requests fail-closed when no admin token is configured", async () => {
    // An empty configured token must never authorize, even against an empty request.
    Bun.env.GUARDIAN_ADMIN_TOKEN_FILE = emptyPath;
    expect((await handleAdminRequest(adminReq(""), "rid-unconfigured-empty")).status).toBe(401);
    expect((await handleAdminRequest(adminReq("anything"), "rid-unconfigured-any")).status).toBe(401);
  });
});
