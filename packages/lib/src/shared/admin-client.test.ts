import { describe, expect, it } from "bun:test";
import {
  resolveAdminBaseUrl,
  resolveAdminToken,
  validateAdminBaseUrl,
} from "./admin-client.ts";

describe("admin-client helpers", () => {
  it("prefers OPENPALM_ADMIN_API_URL over other base URL env vars", () => {
    const baseUrl = resolveAdminBaseUrl({
      OPENPALM_ADMIN_API_URL: "http://admin:8100/",
      ADMIN_APP_URL: "http://localhost:8100",
      GATEWAY_URL: "http://gateway:8080",
    });
    expect(baseUrl).toBe("http://admin:8100");
  });

  it("falls back to ADMIN_TOKEN when OPENPALM_ADMIN_TOKEN is not set", () => {
    const token = resolveAdminToken({
      OPENPALM_ADMIN_TOKEN: "",
      ADMIN_TOKEN: "admin-secret",
    });
    expect(token).toBe("admin-secret");
  });

  it("rejects insecure public HTTP URLs by default", () => {
    expect(() => validateAdminBaseUrl("http://example.com:8100")).toThrow("insecure_admin_api_url");
  });

  it("treats whitespace-only OPENPALM_ADMIN_TOKEN as empty", () => {
    const token = resolveAdminToken({
      OPENPALM_ADMIN_TOKEN: "   ",
      ADMIN_TOKEN: "fallback-token",
    });
    expect(token).toBe("fallback-token");
  });

  it("allows private network HTTP URLs", () => {
    expect(() => validateAdminBaseUrl("http://admin:8100")).not.toThrow();
    expect(() => validateAdminBaseUrl("http://127.0.0.1:8100")).not.toThrow();
  });

  it("allows public HTTP URLs when explicitly enabled", () => {
    expect(() => validateAdminBaseUrl("http://example.com:8100", true)).not.toThrow();
  });
});
