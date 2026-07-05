/**
 * Guardrail tests for the fable-remediation-plan 3.5 "dead-surface deletions"
 * item — pins each dead surface removed by that item so it cannot silently
 * come back:
 *
 *   1. secret-mappings.ts only exports STATIC_CORE_MAPPINGS (the hashed-env
 *      keys / plaintext-index CRUD / classifiers were dead and are removed).
 *   2. paths.ts no longer exports the `data/secrets` helpers that collided
 *      with the live `home.ts` `secretsDir` (knowledge/secrets).
 *   3. setup-config.schema.json (stale v1 shape) is gone — the real
 *      validator (setup-validation.ts) requires v2 + connections.
 *   4. core-assets.ts no longer points readers at a deleted registry.ts.
 *   5. portal loggers use the `portal-*` name, not the pre-rename `channel-*`.
 *   6. containers/portal/README.md's example uses the real portal_* secret
 *      name, not the retired channel_* one.
 *   7. the dead GUARDIAN_REQUIRE_PORTAL_SECRETS flag is gone from the shipped
 *      compose (zero production code ever read it).
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const CONTROL_PLANE_DIR = join(REPO_ROOT, "packages/lib/src/control-plane");

describe("3.5 dead-surface deletions: secret-mappings.ts", () => {
  test("only exports STATIC_CORE_MAPPINGS", async () => {
    const mod = await import("./secret-mappings.js");
    expect(Object.keys(mod).sort()).toEqual(["STATIC_CORE_MAPPINGS"]);
  });
});

describe("3.5 dead-surface deletions: paths.ts", () => {
  test("no longer exports the dead data/secrets helpers", async () => {
    const mod = await import("./paths.js");
    expect((mod as Record<string, unknown>).secretProviderPath).toBeUndefined();
    expect((mod as Record<string, unknown>).secretsIndexPath).toBeUndefined();
    expect((mod as Record<string, unknown>).passStoreDir).toBeUndefined();
    // secretsDir must NOT be (re)introduced here — the live one is home.ts's
    // knowledge/secrets version; a same-named export here silently shadows
    // nothing today only because it's dropped from the `export *` barrel.
    expect((mod as Record<string, unknown>).secretsDir).toBeUndefined();
  });
});

describe("3.5 dead-surface deletions: setup-config.schema.json", () => {
  test("stale v1 schema file is deleted (real validator is v2, see setup-validation.ts)", () => {
    expect(existsSync(join(CONTROL_PLANE_DIR, "setup-config.schema.json"))).toBe(false);
  });
});

describe("3.5 dead-surface deletions: core-assets.ts comment", () => {
  test("does not point at the deleted registry.ts", () => {
    const src = readFileSync(join(CONTROL_PLANE_DIR, "core-assets.ts"), "utf-8");
    expect(src).not.toContain("registry.ts");
  });
});

describe("3.5 dead-surface deletions: portal-* loggers (renamed from channel-*)", () => {
  const files = [
    "portals/discord/src/permissions.ts",
    "portals/discord/src/index.ts",
    "portals/discord/src/commands.ts",
    "portals/discord/src/stream-render.ts",
    "portals/slack/src/index.ts",
    "portals/slack/src/permissions.ts",
    "portals/slack/src/stream-render.ts",
  ];

  for (const rel of files) {
    test(`${rel} does not create a "channel-*" logger`, () => {
      const src = readFileSync(join(REPO_ROOT, rel), "utf-8");
      expect(src).not.toMatch(/createLogger\(["']channel-/);
    });
  }

  test("discord adapter logger is named portal-discord", () => {
    const src = readFileSync(join(REPO_ROOT, "portals/discord/src/index.ts"), "utf-8");
    expect(src).toContain('createLogger("portal-discord")');
  });

  test("slack adapter logger is named portal-slack", () => {
    const src = readFileSync(join(REPO_ROOT, "portals/slack/src/index.ts"), "utf-8");
    expect(src).toContain('createLogger("portal-slack")');
  });
});

describe("3.5 dead-surface deletions: containers/portal/README.md secret names", () => {
  test("example uses the real portal_discord_secret name, not the retired channel_ prefix", () => {
    const readme = readFileSync(join(REPO_ROOT, "containers/portal/README.md"), "utf-8");
    expect(readme).not.toContain("channel_discord_secret");
    expect(readme).toContain("portal_discord_secret");
  });
});

describe("3.5 dead-surface deletions: GUARDIAN_REQUIRE_PORTAL_SECRETS flag", () => {
  test("is gone from the shipped compose (zero production consumers)", () => {
    const compose = readFileSync(
      join(REPO_ROOT, "packages/skeleton/system/stack/portals.compose.yml"),
      "utf-8",
    );
    expect(compose).not.toContain("GUARDIAN_REQUIRE_PORTAL_SECRETS");
  });

  test("is gone from guardian production source", () => {
    const src = readFileSync(join(REPO_ROOT, "packages/guardian/src/server.ts"), "utf-8");
    expect(src).not.toContain("GUARDIAN_REQUIRE_PORTAL_SECRETS");
  });
});
