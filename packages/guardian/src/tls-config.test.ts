/**
 * Pure unit tests of `parseDirectTlsEnv(env)` — spec 435 § 2.1.
 *
 * No subprocess, no sockets (idiom: crypto.test.ts / http-util.test.ts-style
 * direct-import tests against the pure function).
 *
 * RED: `parseDirectTlsEnv` does not exist yet on `./config.ts` — this import
 * throws (module has no such export), failing every test in this file at
 * collection/import time until spec 435's config.ts change lands.
 */
import { describe, it, expect } from "bun:test";
import { parseDirectTlsEnv } from "./config.ts";

describe("parseDirectTlsEnv", () => {
  it("returns off when all TLS vars are unset", () => {
    expect(parseDirectTlsEnv({})).toEqual({ mode: "off" });
  });

  it("returns off when all TLS vars are empty strings", () => {
    // Mirrors the compose `${VAR:-}` default (D3) — empty string must behave
    // identically to fully unset, not as "some vars set".
    expect(
      parseDirectTlsEnv({
        GUARDIAN_TLS_CERT_FILE: "",
        GUARDIAN_TLS_KEY_FILE: "",
        GUARDIAN_MTLS_CA_FILE: "",
      }),
    ).toEqual({ mode: "off" });
  });

  it("returns mtls with the three paths when all set", () => {
    const result = parseDirectTlsEnv({
      GUARDIAN_TLS_CERT_FILE: "/run/secrets/op_guardian_tls_cert",
      GUARDIAN_TLS_KEY_FILE: "/run/secrets/op_guardian_tls_key",
      GUARDIAN_MTLS_CA_FILE: "/run/secrets/op_guardian_mtls_ca",
    });
    expect(result).toEqual({
      mode: "mtls",
      certPath: "/run/secrets/op_guardian_tls_cert",
      keyPath: "/run/secrets/op_guardian_tls_key",
      caPath: "/run/secrets/op_guardian_mtls_ca",
    });
  });

  it("fails closed on cert without key or CA", () => {
    expect(() =>
      parseDirectTlsEnv({
        GUARDIAN_TLS_CERT_FILE: "/run/secrets/op_guardian_tls_cert",
      }),
    ).toThrow(/GUARDIAN_TLS_KEY_FILE/);
    expect(() =>
      parseDirectTlsEnv({
        GUARDIAN_TLS_CERT_FILE: "/run/secrets/op_guardian_tls_cert",
      }),
    ).toThrow(/GUARDIAN_MTLS_CA_FILE/);
  });

  it("fails closed on cert+key without CA (no silent server-only TLS, D3)", () => {
    expect(() =>
      parseDirectTlsEnv({
        GUARDIAN_TLS_CERT_FILE: "/run/secrets/op_guardian_tls_cert",
        GUARDIAN_TLS_KEY_FILE: "/run/secrets/op_guardian_tls_key",
      }),
    ).toThrow(/GUARDIAN_MTLS_CA_FILE/);
  });

  it("fails closed on CA without cert/key", () => {
    expect(() =>
      parseDirectTlsEnv({
        GUARDIAN_MTLS_CA_FILE: "/run/secrets/op_guardian_mtls_ca",
      }),
    ).toThrow(/GUARDIAN_TLS_CERT_FILE/);
    expect(() =>
      parseDirectTlsEnv({
        GUARDIAN_MTLS_CA_FILE: "/run/secrets/op_guardian_mtls_ca",
      }),
    ).toThrow(/GUARDIAN_TLS_KEY_FILE/);
  });
});
