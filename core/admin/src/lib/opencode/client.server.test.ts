/**
 * Tests for opencode/client.server.ts — OpenCode REST API client.
 *
 * Verifies:
 * 1. getOpenCodeProviders returns parsed array on success
 * 2. Returns empty array on HTTP error
 * 3. Returns empty array on network failure (graceful degradation)
 * 4. Handles { providers: [...] } wrapper shape
 * 5. Handles unexpected response shapes gracefully
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

// Mock global fetch
vi.stubGlobal("fetch", fetchMock);

describe("getOpenCodeProviders", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  test("returns array when API returns an array directly", async () => {
    const providers = [{ id: "openai", name: "OpenAI" }, { id: "anthropic", name: "Anthropic" }];
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => providers
    });

    const { getOpenCodeProviders } = await import("./client.server.js");
    const result = await getOpenCodeProviders();
    expect(result).toEqual(providers);
  });

  test("returns providers from wrapped { providers: [...] } shape", async () => {
    const providers = [{ id: "openai" }];
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ providers })
    });

    const { getOpenCodeProviders } = await import("./client.server.js");
    const result = await getOpenCodeProviders();
    expect(result).toEqual(providers);
  });

  test("returns empty array on HTTP error response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "internal" })
    });

    const { getOpenCodeProviders } = await import("./client.server.js");
    const result = await getOpenCodeProviders();
    expect(result).toEqual([]);
  });

  test("returns empty array on network error (graceful degradation)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const { getOpenCodeProviders } = await import("./client.server.js");
    const result = await getOpenCodeProviders();
    expect(result).toEqual([]);
  });

  test("returns empty array for unexpected response shape", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ something: "unexpected" })
    });

    const { getOpenCodeProviders } = await import("./client.server.js");
    const result = await getOpenCodeProviders();
    expect(result).toEqual([]);
  });

  test("returns empty array for null response body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => null
    });

    const { getOpenCodeProviders } = await import("./client.server.js");
    const result = await getOpenCodeProviders();
    expect(result).toEqual([]);
  });
});
