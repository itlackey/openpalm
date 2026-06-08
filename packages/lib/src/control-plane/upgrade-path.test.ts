/**
 * Upgrade-path regression tests.
 *
 * #449 — Check-up "latest" install: a `latest` (or empty) tag selection must be
 * resolved to the concrete newest published platform tag BEFORE fetching stack
 * assets. GitHub has no `.openpalm/...` asset tree at a `latest` ref, so passing
 * `latest` straight through used to fail with a raw download error.
 *
 * #450 — "Update now" must force-recreate guardian + channel containers so they
 * re-resolve their npm dist-tag adapters; guardian must never fall out of the
 * recreated service set.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveLatestPlatformTag, applyTagChange } from "./lifecycle.js";
import type { ControlPlaneState } from "./types.js";

const LIB_CONTROL_PLANE_DIR = join(import.meta.dir);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function dockerTagsResponse(names: string[]): Response {
  return new Response(
    JSON.stringify({ results: names.map((name) => ({ name })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ── #449: latest-tag resolution ──────────────────────────────────────────

describe("resolveLatestPlatformTag (#449)", () => {
  test("returns the newest semver tag from the Docker registry", async () => {
    globalThis.fetch = (async () =>
      dockerTagsResponse(["latest", "v0.11.0", "edge"])) as typeof fetch;

    const tag = await resolveLatestPlatformTag("openpalm");
    expect(tag).toBe("v0.11.0");
  });

  test("throws when the registry yields no usable tag", async () => {
    globalThis.fetch = (async () => dockerTagsResponse(["latest"])) as typeof fetch;
    await expect(resolveLatestPlatformTag("openpalm")).rejects.toThrow(
      /No usable Docker image tag/,
    );
  });
});

describe("applyTagChange latest resolution (#449)", () => {
  function makeState(): ControlPlaneState {
    const home = mkdtempSync(join(tmpdir(), "openpalm-upgrade-test-"));
    mkdirSync(join(home, "knowledge", "env"), { recursive: true });
    writeFileSync(join(home, "knowledge", "env", "stack.env"), "OP_IMAGE_NAMESPACE=openpalm\n");
    return {
      homeDir: home,
      configDir: join(home, "config"),
      stashDir: join(home, "knowledge"),
      workspaceDir: join(home, "workspace"),
      dataDir: join(home, "data"),
      stackDir: join(home, "config", "stack"),
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
    };
  }

  test('a "latest" selection that cannot be resolved fails with a clear validation error, not a raw download error', async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const state = makeState();
    // Resolution happens BEFORE any asset download, so the error must be the
    // resolution message — never the GitHub "Failed to download ..." error.
    await expect(applyTagChange(state, "latest")).rejects.toThrow(
      /Cannot resolve "latest" to a concrete release/,
    );
  });

  test('an empty selection is treated like "latest" and resolved (not passed through as a blank ref)', async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const state = makeState();
    await expect(applyTagChange(state, "   ")).rejects.toThrow(
      /Cannot resolve "latest" to a concrete release/,
    );
  });
});

// ── #450: upgrade recreates guardian + channel containers ─────────────────

describe("performUpgrade force-recreates managed services (#450)", () => {
  test("performUpgrade passes forceRecreate to composeUp", () => {
    const src = readFileSync(join(LIB_CONTROL_PLANE_DIR, "lifecycle.ts"), "utf-8");
    // The post-pull composeUp in performUpgrade must force-recreate so channel
    // containers re-resolve their dist-tag adapters.
    expect(src).toMatch(/composeUp\(\{[^}]*forceRecreate:\s*true/);
  });

  test("buildManagedServices always includes the core services (guardian)", () => {
    const src = readFileSync(join(LIB_CONTROL_PLANE_DIR, "lifecycle.ts"), "utf-8");
    // Guardian comes from CORE_SERVICES and must be seeded into the set
    // regardless of how the rest of the service list is discovered.
    expect(src).toContain("new Set<string>(CORE_SERVICES)");
  });
});
