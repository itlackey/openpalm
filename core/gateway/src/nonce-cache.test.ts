import { describe, expect, it } from "bun:test";
import { NonceCache } from "./nonce-cache.ts";

describe("NonceCache", () => {
  it("accepts a fresh nonce and rejects a duplicate", () => {
    const cache = new NonceCache();
    const nonce = crypto.randomUUID();
    const ts = Date.now();
    expect(cache.checkAndStore(nonce, ts)).toBe(true);
    expect(cache.checkAndStore(nonce, ts)).toBe(false);
    cache.destroy();
  });

  it("rejects nonces with timestamps beyond clock skew", () => {
    const cache = new NonceCache();
    const nonce = crypto.randomUUID();
    const staleTs = Date.now() - 400_000; // 6+ minutes ago
    expect(cache.checkAndStore(nonce, staleTs)).toBe(false);
    cache.destroy();
  });
});
