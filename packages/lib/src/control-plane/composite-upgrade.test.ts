/**
 * Composite 0.11.5 → 0.12.0 upgrade EXIT GATE test.
 *
 * Builds a fully populated 0.11.5 fixture OP_HOME (channels enabled, custom
 * service in custom.compose.yml attached to portal_net, a non-default
 * per-service bind var, and addon non-secret config as a secret file), then
 * runs the full upgrade sequence (ensureMigrated + ensureReleaseMigrated) TWICE
 * and asserts:
 *
 *  - expected stack.env keys present after first run (C4 non-sensitive keys +
 *    hand-set per-image tag escape-hatch keys preserved + OP_RELEASE_VERSION stamp)
 *  - user-file content unchanged for files outside documented upgrade writes
 *    (custom.compose.yml, the secret files, user env)
 *  - second run is a no-op (no duplicated keys, no content change)
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureMigrated,
  ensureReleaseMigrated,
  CURRENT_LAYOUT_VERSION,
} from "./migrations.js";

// ── Fixture ────────────────────────────────────────────────────────────────────

/**
 * Seed a fully-populated 0.11.5 OP_HOME:
 *   - knowledge/env/stack.env with OP_IMAGE_TAG=v0.11.5, OP_RELEASE_VERSION=v0.11.5
 *     and hand-set per-image tag escape-hatch keys (must be preserved, never auto-rewritten)
 *   - knowledge/env/user.env with user preferences
 *   - knowledge/secrets/discord_bot_token (sensitive — must stay as secret)
 *   - knowledge/secrets/discord_allowed_guilds (non-sensitive — C4 copies to stack.env)
 *   - knowledge/secrets/auth.json (must be skipped by C4: has a dot)
 *   - config/stack/custom.compose.yml with a custom service on portal_net
 *   - OP_CHAT_BIND_ADDRESS=0.0.0.0 in stack.env (per-service bind override)
 *   - OP_LAYOUT_VERSION already stamped (this is a 0.11 install)
 */
function seed0115(h: string): void {
  mkdirSync(join(h, "knowledge", "env"), { recursive: true });
  mkdirSync(join(h, "knowledge", "secrets"), { recursive: true });
  mkdirSync(join(h, "config", "stack"), { recursive: true });
  mkdirSync(join(h, "data"), { recursive: true });

  // stack.env — 0.11.5 state with hand-set per-image tag escape-hatch keys
  writeFileSync(
    join(h, "knowledge", "env", "stack.env"),
    [
      "OP_IMAGE_TAG=v0.11.5",
      "OP_RELEASE_VERSION=v0.11.5",
      `OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`,
      "OP_ASSISTANT_IMAGE_TAG=v0.11.5",
      "OP_GUARDIAN_IMAGE_TAG=v0.11.5",
      "OP_PORTAL_IMAGE_TAG=v0.11.5",
      "OP_ENABLED_ADDONS=discord",
      "OP_CHAT_BIND_ADDRESS=0.0.0.0",
      "OP_HOST_UI_PORT=8100",
      "",
    ].join("\n"),
  );

  // user.env — user preferences, must not be touched
  writeFileSync(
    join(h, "knowledge", "env", "user.env"),
    "MY_PREF=keep-this\nANOTHER=value\n",
  );

  // Sensitive secret file — must NOT be copied to stack.env
  writeFileSync(
    join(h, "knowledge", "secrets", "discord_bot_token"),
    "Bot.MyVerySecretToken\n",
  );

  // Non-sensitive addon config — C4 migration must copy to stack.env
  writeFileSync(
    join(h, "knowledge", "secrets", "discord_allowed_guilds"),
    "11111,22222\n",
  );

  // auth.json — has a dot; must be skipped by C4 migration
  writeFileSync(
    join(h, "knowledge", "secrets", "auth.json"),
    '{"openai":{"type":"api"}}\n',
  );

  // custom.compose.yml — user-written custom service attached to portal_net
  writeFileSync(
    join(h, "config", "stack", "custom.compose.yml"),
    [
      "services:",
      "  my-custom-bot:",
      "    image: myorg/my-bot:latest",
      "    networks:",
      "      - portal_net",
      "networks:",
      "  portal_net:",
      "    external: true",
      "",
    ].join("\n"),
  );
}

// ── Test suite ─────────────────────────────────────────────────────────────────

let home: string;
let prevOpHome: string | undefined;

beforeEach(() => {
  prevOpHome = process.env.OP_HOME;
  home = mkdtempSync(join(tmpdir(), "op-composite-upgrade-"));
  process.env.OP_HOME = home;
  seed0115(home);
});

afterEach(() => {
  if (prevOpHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = prevOpHome;
  rmSync(home, { recursive: true, force: true });
});

describe("composite 0.11.5 → 0.12.0 upgrade EXIT GATE", () => {
  // ── helpers ──────────────────────────────────────────────────────────────

  function stackEnv(): string {
    return readFileSync(join(home, "knowledge", "env", "stack.env"), "utf-8");
  }

  function userEnv(): string {
    return readFileSync(join(home, "knowledge", "env", "user.env"), "utf-8");
  }

  function customCompose(): string {
    return readFileSync(join(home, "config", "stack", "custom.compose.yml"), "utf-8");
  }

  function secretFile(name: string): string {
    return readFileSync(join(home, "knowledge", "secrets", name), "utf-8");
  }

  function countOccurrences(text: string, key: string): number {
    return (text.match(new RegExp(`^${key}=`, "mg")) ?? []).length;
  }

  // ── run 1 ─────────────────────────────────────────────────────────────────

  it("run 1: ensureMigrated is a no-op for an already-stamped 0.11 install", () => {
    const report = ensureMigrated({ homeDir: home });
    // Layout is already current + release stamp matches image tag → fast-path no-op.
    expect(report.migrated).toBe(false);
    expect(report.to).toBe(CURRENT_LAYOUT_VERSION);
    expect(report.applied).toEqual([]); // no layout migrations applied
  });

  it("run 1: ensureReleaseMigrated copies non-sensitive C4 key to stack.env", () => {
    ensureMigrated({ homeDir: home });
    const report = ensureReleaseMigrated({
      homeDir: home,
      targetVersion: "v0.12.0",
    });

    expect(report.migrated).toBe(true);
    expect(report.applied).toContain("v0.12.0-rc.1");

    const env = stackEnv();
    // C4 non-sensitive key copied
    expect(env).toContain("DISCORD_ALLOWED_GUILDS=11111,22222");
    // Sensitive key NOT copied
    expect(env).not.toContain("DISCORD_BOT_TOKEN");
    // auth.json (dot in name) NOT copied
    expect(env).not.toContain("AUTH.JSON");
    expect(env).not.toContain("auth.json");
  });

  it("run 1: hand-set per-image tag escape-hatch keys are converted to per-unit version vars after upgrade", () => {
    ensureMigrated({ homeDir: home });
    // Target a version >= the image-tag→version migration (v0.12.18) so the
    // legacy *_IMAGE_TAG keys are mapped onto the new per-unit *_VERSION vars.
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.18" });

    const env = stackEnv();
    // Hand-set per-image escape-hatch keys carry their pinned values forward — the
    // release migration converts the old *_IMAGE_TAG keys to the new per-unit
    // *_VERSION keys and drops the old ones.
    expect(env).toContain("OP_ASSISTANT_VERSION=v0.11.5");
    expect(env).toContain("OP_GUARDIAN_VERSION=v0.11.5");
    expect(env).toContain("OP_PORTAL_VERSION=v0.11.5");
    expect(env).not.toContain("OP_ASSISTANT_IMAGE_TAG=");
    expect(env).not.toContain("OP_GUARDIAN_IMAGE_TAG=");
    expect(env).not.toContain("OP_PORTAL_IMAGE_TAG=");
  });

  it("run 1: OP_RELEASE_VERSION is stamped to the target version", () => {
    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });

    expect(stackEnv()).toContain("OP_RELEASE_VERSION=v0.12.0");
  });

  it("run 1: per-service bind override is preserved in stack.env", () => {
    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });

    expect(stackEnv()).toContain("OP_CHAT_BIND_ADDRESS=0.0.0.0");
  });

  // ── user-file content invariants ──────────────────────────────────────────

  it("run 1: custom.compose.yml is not modified by the upgrade", () => {
    const before = customCompose();
    const beforeMtime = statSync(join(home, "config", "stack", "custom.compose.yml")).mtimeMs;

    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });

    expect(customCompose()).toBe(before);
    // mtime must not change (file must not be rewritten)
    expect(statSync(join(home, "config", "stack", "custom.compose.yml")).mtimeMs).toBe(beforeMtime);
  });

  it("run 1: user.env is not touched by the upgrade", () => {
    const before = userEnv();
    const beforeMtime = statSync(join(home, "knowledge", "env", "user.env")).mtimeMs;

    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });

    expect(userEnv()).toBe(before);
    expect(statSync(join(home, "knowledge", "env", "user.env")).mtimeMs).toBe(beforeMtime);
  });

  it("run 1: secret files are not deleted (copy-only, never delete)", () => {
    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });

    // All source secret files must still exist and have unchanged content
    expect(existsSync(join(home, "knowledge", "secrets", "discord_bot_token"))).toBe(true);
    expect(existsSync(join(home, "knowledge", "secrets", "discord_allowed_guilds"))).toBe(true);
    expect(existsSync(join(home, "knowledge", "secrets", "auth.json"))).toBe(true);

    expect(secretFile("discord_bot_token").trim()).toBe("Bot.MyVerySecretToken");
    expect(secretFile("discord_allowed_guilds").trim()).toBe("11111,22222");
  });

  // ── run 2 idempotency ─────────────────────────────────────────────────────

  it("run 2: ensureMigrated is a no-op", () => {
    // Run 1
    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });

    // Run 2
    const report2 = ensureMigrated({ homeDir: home });
    expect(report2.migrated).toBe(false);
    expect(report2.to).toBe(CURRENT_LAYOUT_VERSION);
  });

  it("run 2: ensureReleaseMigrated is a no-op (already at v0.12.0)", () => {
    // Run 1
    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });

    // Run 2
    const report2 = ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });
    expect(report2.migrated).toBe(false);
    expect(report2.applied).toEqual([]);
  });

  it("run 2: no keys are duplicated in stack.env after two upgrade passes", () => {
    // Run 1 — target >= v0.12.18 so the image-tag→version migration fires and
    // the asserted OP_*_VERSION keys exist.
    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.18" });

    // Run 2
    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.18" });

    const env = stackEnv();

    // Each key must appear exactly once
    for (const key of [
      "OP_RELEASE_VERSION",
      "OP_LAYOUT_VERSION",
      "OP_ASSISTANT_VERSION",
      "OP_GUARDIAN_VERSION",
      "OP_PORTAL_VERSION",
      "DISCORD_ALLOWED_GUILDS",
      "OP_CHAT_BIND_ADDRESS",
    ]) {
      expect(countOccurrences(env, key), `${key} duplicated`).toBe(1);
    }
  });

  it("run 2: stack.env content is identical after the second pass", () => {
    // Run 1
    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });
    const afterRun1 = stackEnv();

    // Run 2
    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });
    const afterRun2 = stackEnv();

    expect(afterRun2).toBe(afterRun1);
  });

  it("run 2: custom.compose.yml is still identical after two passes", () => {
    const original = customCompose();

    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });

    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });

    expect(customCompose()).toBe(original);
  });

  it("run 2: user.env is still identical after two passes", () => {
    const original = userEnv();

    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });

    ensureMigrated({ homeDir: home });
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.0" });

    expect(userEnv()).toBe(original);
  });

  // ── complete stack.env key set ─────────────────────────────────────────────

  it("final stack.env contains all expected keys from the 0.11.5 → v0.12.18 upgrade", () => {
    ensureMigrated({ homeDir: home });
    // Target >= v0.12.18 so the image-tag→version migration fires and the
    // per-unit OP_*_VERSION keys are present in the final stack.env.
    ensureReleaseMigrated({ homeDir: home, targetVersion: "v0.12.18" });

    const env = stackEnv();

    // Layout stamp
    expect(env).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);
    // Release stamp bumped to target
    expect(env).toContain("OP_RELEASE_VERSION=v0.12.18");
    // Addons preserved
    expect(env).toContain("OP_ENABLED_ADDONS=discord");
    // Per-service bind var preserved
    expect(env).toContain("OP_CHAT_BIND_ADDRESS=0.0.0.0");
    // Hand-set per-image escape-hatch keys converted to per-unit version keys
    expect(env).toContain("OP_ASSISTANT_VERSION=");
    expect(env).toContain("OP_GUARDIAN_VERSION=");
    expect(env).toContain("OP_PORTAL_VERSION=");
    // C4 non-sensitive addon config promoted
    expect(env).toContain("DISCORD_ALLOWED_GUILDS=11111,22222");
    // Sensitive keys never promoted
    expect(env).not.toContain("DISCORD_BOT_TOKEN");
    // Portal escape-hatch tag preserved at the hand-set value
    expect(env).toMatch(/OP_PORTAL_VERSION=v0\.11\./);
  });
});
