import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { NonceCache } from "./nonce-cache.ts";

describe("nonce cache persistence", () => {
  it("does not persist synchronously on every checkAndStore call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-nonce-"));
    const cachePath = join(dir, "nonce-cache.json");

    const cache = new NonceCache(cachePath);
    expect(cache.checkAndStore(crypto.randomUUID(), Date.now())).toBe(true);

    // Persistence is debounced and should not be written immediately.
    expect(existsSync(cachePath)).toBe(false);

    await Bun.sleep(20);
    expect(existsSync(cachePath)).toBe(false);

    cache.destroy();
    expect(existsSync(cachePath)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("persists nonces between instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-nonce-"));
    const cachePath = join(dir, "nonce-cache.json");

    const first = new NonceCache(cachePath);
    const nonce = crypto.randomUUID();
    const timestamp = Date.now();
    expect(first.checkAndStore(nonce, timestamp)).toBe(true);
    first.destroy();

    const second = new NonceCache(cachePath);
    expect(second.checkAndStore(nonce, timestamp)).toBe(false);
    second.destroy({ clear: true });

    rmSync(dir, { recursive: true, force: true });
  });
});
