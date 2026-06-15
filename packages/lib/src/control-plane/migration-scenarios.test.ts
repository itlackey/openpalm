/**
 * Migration SCENARIO tests.
 *
 * Each test seeds a temporary OP_HOME representing a real version / install
 * scenario (the "fixture"), runs the migration sequence a real upgrade performs,
 * and validates the ENTIRE resulting OP_HOME state against the expected result —
 * the exact set of files present (proving inert files were removed and nothing
 * leaked or went missing) plus the content of every transformed file, and that a
 * recovery backup was taken first.
 *
 * Unit-level per-migration behavior lives in migrations.test.ts; this file is the
 * end-to-end "given a vX home, after upgrade it looks exactly like this" net.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ensureMigrated, ensureReleaseMigrated, CURRENT_LAYOUT_VERSION } from "./migrations.js";

let home: string;
let prevOpHome: string | undefined;

beforeEach(() => {
  prevOpHome = process.env.OP_HOME;
  home = mkdtempSync(join(tmpdir(), "op-mig-scenario-"));
  process.env.OP_HOME = home;
});

afterEach(() => {
  if (prevOpHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = prevOpHome;
  rmSync(home, { recursive: true, force: true });
});

// ── Fixtures: a scenario is a flat map of relpath -> file content ────────────────
function seed(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(home, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/**
 * Walk the home into a normalized snapshot: relpath -> content for files.
 * The timestamped backup tree under data/backups is collapsed to a single
 * "data/backups/" marker (it's non-deterministic; existence is asserted instead).
 */
function snapshot(): Record<string, string> {
  const acc: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = full.slice(home.length + 1);
      if (rel === "data/backups" || rel.startsWith("data/backups/")) { acc["data/backups/"] = "<exists>"; continue; }
      if (entry.isDirectory()) walk(full);
      else acc[rel] = readFileSync(full, "utf-8");
    }
  };
  walk(home);
  return acc;
}

/** Sorted set of file relpaths currently in the home (backups collapsed). */
function fileSet(): string[] {
  return Object.keys(snapshot()).sort();
}

function readEnv(): string {
  return readFileSync(join(home, "knowledge", "env", "stack.env"), "utf-8");
}

/** The migration sequence a real `openpalm update` runs: layout, then release. */
function runUpgrade(target: string) {
  const layout = ensureMigrated();
  const release = ensureReleaseMigrated({ targetVersion: target });
  return { layout, release };
}

// ── Scenario 1: 0.11.x (layout v1) + channels → 0.12.0 — the real-world upgrade ──
describe("scenario: 0.11.5 channels install → 0.12.0-rc.5", () => {
  function seed011Channels(): void {
    seed({
      "knowledge/env/stack.env": [
        "OP_SETUP_COMPLETE=true",
        "OP_LAYOUT_VERSION=1",
        "OP_IMAGE_TAG=v0.11.5",
        "OP_RELEASE_VERSION=v0.11.5",
        "OP_ENABLED_ADDONS=discord",
        "",
      ].join("\n"),
      // per-portal verification secrets (old "channel_" names) — to be renamed
      "knowledge/secrets/channel_api_secret": "api-sec\n",
      "knowledge/secrets/channel_chat_secret": "chat-sec\n",
      "knowledge/secrets/channel_discord_secret": "disc-sec\n",
      "knowledge/secrets/channel_slack_secret": "slack-sec\n",
      // addon config wrongly stored as secret files (pre-C4)
      "knowledge/secrets/discord_application_id": "123456\n",
      "knowledge/secrets/discord_allowed_guilds": "g1,g2\n",
      "knowledge/secrets/discord_custom_commands": "a,b\n", // NOT a declared addon key
      // genuinely sensitive — must stay a secret file, never reach stack.env
      "knowledge/secrets/discord_bot_token": "Bot.SECRET\n",
      "knowledge/secrets/op_ui_login_password": "hunter2\n",
      // general credential files — must NEVER be copied into stack.env
      "knowledge/secrets/ssh-key-openpalm": "-----BEGIN OPENSSH PRIVATE KEY-----\nXXX\n",
      "knowledge/secrets/github-itlackey": "ghp_REDACTED\n",
      "knowledge/secrets/auth.json": "{}\n",
      // managed compose (kept) + inert pre-0.12 files (removed)
      "config/stack/core.compose.yml": "services:\n  guardian: {}\n",
      "config/stack/services.compose.yml": "services: {}\n",
      "config/stack/channels.compose.yml": "services: {}\n", // inert → removed
      "config/stack/stack.yml": "version: 2\n",              // inert → removed
      "config/stack/custom.compose.yml": "services:\n  mine:\n    networks: [channel_lan]\nnetworks:\n  channel_lan:\n",
      // a user config file that must never be touched
      "config/assistant/persona.md": "you are helpful\n",
    });
  }

  it("produces exactly the expected 0.12.0 home and backs up first", () => {
    seed011Channels();
    const { layout } = runUpgrade("v0.12.0-rc.5");

    // EXACT resulting file set — proves inert files gone, secrets renamed,
    // credential files NOT leaked, user/managed files kept, nothing extra.
    expect(fileSet()).toEqual([
      "config/assistant/persona.md",
      "config/stack/core.compose.yml",
      "config/stack/custom.compose.yml",
      "config/stack/custom.compose.yml.pre-portal-rename.bak",
      "config/stack/services.compose.yml",
      // channels.compose.yml + stack.yml are GONE (inert, removed by layout v1→v2)
      "data/backups/",
      "knowledge/env/stack.env",
      "knowledge/secrets/auth.json",
      "knowledge/secrets/discord_allowed_guilds",
      "knowledge/secrets/discord_application_id",
      "knowledge/secrets/discord_bot_token",
      "knowledge/secrets/discord_custom_commands",
      "knowledge/secrets/github-itlackey",
      "knowledge/secrets/op_ui_login_password",
      // channel_*_secret RENAMED to portal_*_secret (old names gone)
      "knowledge/secrets/portal_api_secret",
      "knowledge/secrets/portal_chat_secret",
      "knowledge/secrets/portal_discord_secret",
      "knowledge/secrets/portal_slack_secret",
      "knowledge/secrets/ssh-key-openpalm",
    ]);

    // Layout stamped to current; a full-home backup was taken first.
    const env = readEnv();
    expect(env).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);
    expect(env).toContain("OP_RELEASE_VERSION=v0.12.0-rc.5");
    expect(layout.backupDir).toBeTruthy();
    expect(existsSync(layout.backupDir!)).toBe(true);

    // Secret values preserved through the rename.
    expect(readFileSync(join(home, "knowledge", "secrets", "portal_discord_secret"), "utf-8").trim()).toBe("disc-sec");

    // Declared non-sensitive addon config copied into stack.env.
    expect(env).toContain("DISCORD_APPLICATION_ID=123456");
    expect(env).toContain("DISCORD_ALLOWED_GUILDS=g1,g2");
    // Sensitive + non-schema + credential keys NEVER copied into stack.env.
    expect(env).not.toContain("DISCORD_BOT_TOKEN");
    expect(env).not.toContain("DISCORD_CUSTOM_COMMANDS");
    expect(env).not.toContain("SSH-KEY");
    expect(env).not.toContain("GITHUB");
    expect(env).not.toContain("BEGIN OPENSSH");
    expect(env).not.toContain("ghp_REDACTED");

    // custom.compose.yml rewritten channel_lan → portal_net (original backed up).
    const custom = readFileSync(join(home, "config", "stack", "custom.compose.yml"), "utf-8");
    expect(custom).not.toContain("channel_lan");
    expect(custom).toContain("portal_net");
    expect(readFileSync(join(home, "config", "stack", "custom.compose.yml.pre-portal-rename.bak"), "utf-8"))
      .toContain("channel_lan");

    // The inert files are recoverable from the full-home backup.
    expect(existsSync(join(layout.backupDir!, "config", "stack", "channels.compose.yml"))).toBe(true);
    expect(existsSync(join(layout.backupDir!, "config", "stack", "stack.yml"))).toBe(true);

    // User config untouched.
    expect(readFileSync(join(home, "config", "assistant", "persona.md"), "utf-8")).toBe("you are helpful\n");
  });

  it("is idempotent — a second upgrade run changes nothing", () => {
    seed011Channels();
    runUpgrade("v0.12.0-rc.5");
    const after1 = snapshot();
    delete after1["data/backups/"]; // backup dirs accumulate; compare the rest

    const second = runUpgrade("v0.12.0-rc.5");
    expect(second.layout.migrated).toBe(false);
    expect(second.release.migrated).toBe(false);

    const after2 = snapshot();
    delete after2["data/backups/"];
    expect(after2).toEqual(after1);
  });
});

// ── Scenario 2: 0.10.x vault layout → 0.12.0 (layout 0 → 1 → 2) ──────────────────
describe("scenario: 0.10.x vault install → 0.12.0", () => {
  it("migrates the vault layout, retains it as a recovery copy, and reaches v2", () => {
    seed({
      "vault/user/user.env": "MY_PREF=hello\n",
      "vault/stack/stack.env": "OP_ADMIN_PORT=9000\nOP_UI_LOGIN_PASSWORD=hunter2\nOP_ASSISTANT_PORT=3800\n",
      "vault/stack/guardian.env": "CHANNEL_DISCORD_SECRET=disc-abc\n",
      "vault/stack/auth.json": "{}\n",
      "config/stack.yml": "version: 1\ncapabilities:\n  llm: openai\n",
      "data/.keep": "",
    });

    const report = ensureMigrated();

    expect(report.from).toBe(0);
    expect(report.to).toBe(CURRENT_LAYOUT_VERSION); // 0 → 1 → 2 chained
    expect(report.backupDir).toBeTruthy();

    // New 0.11+ knowledge layout produced.
    expect(existsSync(join(home, "knowledge", "env", "stack.env"))).toBe(true);
    expect(readFileSync(join(home, "knowledge", "env", "user.env"), "utf-8")).toContain("MY_PREF=hello");
    expect(readFileSync(join(home, "knowledge", "secrets", "op_ui_login_password"), "utf-8").trim()).toBe("hunter2");
    expect(existsSync(join(home, "knowledge", "secrets", "channel_discord_secret"))).toBe(true);
    // The login port was renamed during the 0→1 migration.
    expect(readEnv()).toContain("OP_HOST_UI_PORT=9000");
    expect(readEnv()).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);

    // The legacy vault/ is RETAINED (user data — never auto-deleted) with a README.
    expect(existsSync(join(home, "vault", "stack", "stack.env"))).toBe(true);
    expect(existsSync(join(home, "vault", "README.md"))).toBe(true);
  });
});

// ── Scenario 3: minimal/fresh v1 install → clean stamp to current ───────────────
describe("scenario: minimal v1 install", () => {
  it("stamps to the current layout and removes nothing it shouldn't", () => {
    seed({
      "knowledge/env/stack.env": "OP_LAYOUT_VERSION=1\nOP_IMAGE_TAG=v0.11.5\nOP_RELEASE_VERSION=v0.11.5\n",
      "config/stack/core.compose.yml": "services: {}\n",
      "data/.keep": "",
    });

    const report = ensureMigrated();
    expect(report.from).toBe(1);
    expect(report.to).toBe(CURRENT_LAYOUT_VERSION);

    expect(fileSet()).toEqual([
      "config/stack/core.compose.yml",
      "data/.keep",
      "data/backups/",
      "knowledge/env/stack.env",
    ]);
    expect(readEnv()).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);
  });
});

// ── Scenario 4: already-current home → idempotent no-op ─────────────────────────
describe("scenario: already at the current layout", () => {
  it("does nothing on an up-to-date home", () => {
    seed({
      "knowledge/env/stack.env": `OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}\nOP_RELEASE_VERSION=v0.12.0-rc.5\n`,
      "config/stack/core.compose.yml": "services: {}\n",
      "data/.keep": "",
    });
    const before = snapshot();

    const report = ensureMigrated();
    expect(report.migrated).toBe(false);
    expect(report.backupDir).toBeNull(); // no backup taken when nothing migrates

    expect(snapshot()).toEqual(before); // byte-for-byte unchanged
  });
});
