import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { NonceCache } from "./nonce-cache.ts";

describe("nonce cache persistence", () => {
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
