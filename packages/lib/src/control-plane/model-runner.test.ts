import { describe, expect, test } from "bun:test";
import { parseOllamaHostEnv } from "./model-runner.js";

describe("parseOllamaHostEnv", () => {
  // ── null / empty inputs ────────────────────────────────────────────────
  test("undefined → null", () => {
    expect(parseOllamaHostEnv(undefined)).toBeNull();
  });

  test("empty string → null", () => {
    expect(parseOllamaHostEnv("")).toBeNull();
  });

  test("whitespace only → null", () => {
    expect(parseOllamaHostEnv("   ")).toBeNull();
  });

  // ── garbage ────────────────────────────────────────────────────────────
  test("/garbage → null", () => {
    expect(parseOllamaHostEnv("/garbage")).toBeNull();
  });

  test("has spaces → null", () => {
    expect(parseOllamaHostEnv("my host:1234")).toBeNull();
  });

  test("port out of range 0 → null", () => {
    expect(parseOllamaHostEnv("0")).toBeNull();
  });

  test("port out of range 99999 → null", () => {
    expect(parseOllamaHostEnv("99999")).toBeNull();
  });

  test("invalid host:port (port not numeric) → null", () => {
    expect(parseOllamaHostEnv("localhost:abc")).toBeNull();
  });

  // ── bare port ──────────────────────────────────────────────────────────
  test("bare port '9999' → http://localhost:9999", () => {
    expect(parseOllamaHostEnv("9999")).toBe("http://localhost:9999");
  });

  test("bare port '11434' → http://localhost:11434", () => {
    expect(parseOllamaHostEnv("11434")).toBe("http://localhost:11434");
  });

  // ── host:port ──────────────────────────────────────────────────────────
  test("'127.0.0.1:9999' → http://127.0.0.1:9999", () => {
    expect(parseOllamaHostEnv("127.0.0.1:9999")).toBe("http://127.0.0.1:9999");
  });

  test("'0.0.0.0:9999' → http://0.0.0.0:9999", () => {
    expect(parseOllamaHostEnv("0.0.0.0:9999")).toBe("http://0.0.0.0:9999");
  });

  test("'myhost:1234' → http://myhost:1234", () => {
    expect(parseOllamaHostEnv("myhost:1234")).toBe("http://myhost:1234");
  });

  // ── full HTTP URL ──────────────────────────────────────────────────────
  test("'http://127.0.0.1:9999' → http://127.0.0.1:9999", () => {
    expect(parseOllamaHostEnv("http://127.0.0.1:9999")).toBe("http://127.0.0.1:9999");
  });

  test("'http://127.0.0.1:9999/some/path' strips path", () => {
    // URL.origin includes scheme+host+port, strips path
    expect(parseOllamaHostEnv("http://127.0.0.1:9999/some/path")).toBe("http://127.0.0.1:9999");
  });

  // ── HTTPS URL ─────────────────────────────────────────────────────────
  test("'https://h:443' → https://h:443", () => {
    // URL.origin suppresses default port 443 for https
    const result = parseOllamaHostEnv("https://h:443");
    expect(result).toBe("https://h");
  });

  test("'https://secure.host:8443' → https://secure.host:8443", () => {
    expect(parseOllamaHostEnv("https://secure.host:8443")).toBe("https://secure.host:8443");
  });

  // ── bare hostname ──────────────────────────────────────────────────────
  test("'localhost' → http://localhost:11434 (default port)", () => {
    expect(parseOllamaHostEnv("localhost")).toBe("http://localhost:11434");
  });

  test("'my-host.local' → http://my-host.local:11434", () => {
    expect(parseOllamaHostEnv("my-host.local")).toBe("http://my-host.local:11434");
  });

  // ── whitespace trimming ────────────────────────────────────────────────
  test("leading/trailing whitespace is trimmed", () => {
    expect(parseOllamaHostEnv("  9999  ")).toBe("http://localhost:9999");
  });
});
