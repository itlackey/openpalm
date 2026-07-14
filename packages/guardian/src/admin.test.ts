/**
 * Admin authorization gate.
 *
 * Exercises handleAdminRequest's Bearer-token check (which now uses the shared
 * constant-time compare): the correct token is accepted, wrong/empty tokens are
 * rejected 401, and an unconfigured (empty) admin token denies all requests
 * fail-closed. Uses a GET /admin/principals request since it needs no body.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
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

function adminPost(body: unknown, token = ADMIN_TOKEN): Request {
  return new Request("http://localhost/admin/principals", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

  // PR #564 retest: the principal id is the Basic-auth username — an id with a
  // colon (or whitespace) can never authenticate, so the create must be rejected
  // 400 rather than minting a dead principal. These 400s return before any DB.
  it("rejects a principal id containing a colon (breaks Basic auth parsing)", async () => {
    Bun.env.GUARDIAN_ADMIN_TOKEN_FILE = tokenPath;
    const res = await handleAdminRequest(adminPost({ id: "phone:one", kind: "direct", token: "t" }), "rid-colon");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_principal_id");
  });

  it("rejects an unknown principal kind instead of silently coercing to portal", async () => {
    Bun.env.GUARDIAN_ADMIN_TOKEN_FILE = tokenPath;
    const res = await handleAdminRequest(adminPost({ id: "dev-x", kind: "superuser", token: "t" }), "rid-kind");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_kind");
  });

  // PR #564 retest: rotating the token file's CONTENTS in place must take effect
  // without a guardian restart. The old path-only cache left token A valid and
  // token B rejected; keying on mtime fixes it.
  it("honors an in-place admin-token rotation (mtime-keyed cache)", async () => {
    const rotatePath = join(tmpDir, "rotating-token");
    writeFileSync(rotatePath, "token-A\n");
    Bun.env.GUARDIAN_ADMIN_TOKEN_FILE = rotatePath;

    expect((await handleAdminRequest(adminReq("token-A"), "rid-A")).status).toBe(200);
    expect((await handleAdminRequest(adminReq("token-B"), "rid-B-before")).status).toBe(401);

    // Rotate contents in place and bump mtime forward so the change is observable
    // even on coarse-granularity filesystems.
    writeFileSync(rotatePath, "token-B\n");
    const future = new Date(Date.now() + 5000);
    utimesSync(rotatePath, future, future);

    expect((await handleAdminRequest(adminReq("token-B"), "rid-B-after")).status).toBe(200);
    expect((await handleAdminRequest(adminReq("token-A"), "rid-A-after")).status).toBe(401);
  });
});
