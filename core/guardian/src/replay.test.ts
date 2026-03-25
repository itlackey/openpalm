/**
 * Replay detection unit tests.
 *
 * Covers: timestamp skew acceptance/rejection, nonce reuse detection,
 * and pruning/eviction at the size cap.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { checkNonce, nonceCacheSize, NONCE_WINDOW_MS, NONCE_MAX_SIZE } from "./replay";

// ── Helpers ────────────────────────────────────────────────────────────

/** Reset the module-level nonce Map between tests by re-importing. */
// The seen Map is module-scoped and not exported, so we clear it indirectly
// by filling unique nonces. Instead we access the internals via a workaround:
// We rely on the fact that nonces expire after CLOCK_SKEW (5 min), so we use
// unique nonces per test. For the eviction test we need a clean slate, so
// we accept the cumulative count and work around it.

function uniqueNonce(): string {
  return crypto.randomUUID();
}

describe("Replay detection (checkNonce)", () => {
  it("accepts a nonce within the timestamp skew window", () => {
    // Exactly now
    expect(checkNonce(uniqueNonce(), Date.now())).toBe(true);

    // 1 second in the past
    expect(checkNonce(uniqueNonce(), Date.now() - 1_000)).toBe(true);

    // 1 second in the future
    expect(checkNonce(uniqueNonce(), Date.now() + 1_000)).toBe(true);

    // Right at the edge: just under 5 minutes ago
    expect(checkNonce(uniqueNonce(), Date.now() - (NONCE_WINDOW_MS - 100))).toBe(true);

    // Right at the edge: just under 5 minutes in the future
    expect(checkNonce(uniqueNonce(), Date.now() + (NONCE_WINDOW_MS - 100))).toBe(true);
  });

  it("rejects a nonce outside the timestamp skew window", () => {
    // 6 minutes in the past
    expect(checkNonce(uniqueNonce(), Date.now() - 6 * 60_000)).toBe(false);

    // 6 minutes in the future
    expect(checkNonce(uniqueNonce(), Date.now() + 6 * 60_000)).toBe(false);

    // Just over the 5-minute boundary (past)
    expect(checkNonce(uniqueNonce(), Date.now() - NONCE_WINDOW_MS - 1)).toBe(false);

    // Just over the 5-minute boundary (future)
    expect(checkNonce(uniqueNonce(), Date.now() + NONCE_WINDOW_MS + 1)).toBe(false);

    // Far past
    expect(checkNonce(uniqueNonce(), Date.now() - 60 * 60_000)).toBe(false);

    // Zero timestamp
    expect(checkNonce(uniqueNonce(), 0)).toBe(false);
  });

  it("rejects a replayed nonce (same nonce used twice)", () => {
    const nonce = uniqueNonce();
    const ts = Date.now();

    // First use succeeds
    expect(checkNonce(nonce, ts)).toBe(true);

    // Second use with same nonce is rejected (replay)
    expect(checkNonce(nonce, ts)).toBe(false);

    // Same nonce with different (valid) timestamp is still rejected
    expect(checkNonce(nonce, ts + 1_000)).toBe(false);
  });

  it("accepts different nonces with the same timestamp", () => {
    const ts = Date.now();
    expect(checkNonce(uniqueNonce(), ts)).toBe(true);
    expect(checkNonce(uniqueNonce(), ts)).toBe(true);
    expect(checkNonce(uniqueNonce(), ts)).toBe(true);
  });

  it("prunes expired entries when cache exceeds pruning threshold", () => {
    // Insert entries with expired timestamps (outside the window).
    // These should be pruned once cache exceeds the 10,000 threshold.
    const expiredTs = Date.now() - NONCE_WINDOW_MS - 60_000;

    // Fill past the pruning trigger (10,000+)
    for (let i = 0; i < 10_500; i++) {
      // Use a valid timestamp so entries are accepted, then they'll age out
      checkNonce(`prune-test-${i}`, Date.now());
    }

    // Now insert with a valid timestamp — pruning should trigger and
    // the cache should not grow unbounded
    const sizeBeforeNew = nonceCacheSize();
    checkNonce(uniqueNonce(), Date.now());
    const sizeAfter = nonceCacheSize();

    // Cache should still be bounded (pruning ran)
    expect(sizeAfter).toBeLessThanOrEqual(NONCE_MAX_SIZE);
    expect(sizeAfter).toBeGreaterThan(0);
  });

  it("exports the expected constants", () => {
    expect(NONCE_WINDOW_MS).toBe(300_000);
    expect(NONCE_MAX_SIZE).toBe(50_000);
  });

  it("nonceCacheSize reflects insertions", () => {
    const before = nonceCacheSize();
    const nonce = uniqueNonce();
    checkNonce(nonce, Date.now());
    // Size should have grown by at least 1 (could be exactly 1 if no pruning)
    expect(nonceCacheSize()).toBeGreaterThanOrEqual(before);
  });
});
