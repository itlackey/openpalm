import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMigrated, ensureReleaseMigrated, MigrationError, BackupSpaceError, CURRENT_LAYOUT_VERSION, selectPendingReleaseMigrations, releaseMigrationVersions } from "./migrations.js";

// The harness resolves all paths from OP_HOME; point it at a synthetic 0.10 home.
let home: string;
let prevOpHome: string | undefined;

function seed010(h: string): void {
  mkdirSync(join(h, "vault", "user"), { recursive: true });
  mkdirSync(join(h, "vault", "stack", "services"), { recursive: true });
  mkdirSync(join(h, "config"), { recursive: true });
  mkdirSync(join(h, "data"), { recursive: true });
  writeFileSync(join(h, "vault", "user", "user.env"), "MY_PREF=hello\n");
  writeFileSync(
    join(h, "vault", "stack", "stack.env"),
    [
      "# system env",
      "OP_HOME=/x/.openpalm",
      "OP_ADMIN_PORT=9000",
      "OPENAI_API_KEY=sk-secret123",
      "OP_CAP_LLM_MODEL=gpt-4",
      "TTS_VOICE=alloy",
      "OP_UI_LOGIN_PASSWORD=hunter2",
      "OP_ASSISTANT_PORT=3800",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(h, "vault", "stack", "guardian.env"),
    "CHANNEL_DISCORD_SECRET=disc-abc\nCHANNEL_SLACK_SECRET=slack-xyz\n",
  );
  writeFileSync(join(h, "vault", "stack", "services", "some.secret"), "svc-val\n");
  writeFileSync(join(h, "vault", "user", "apprise.yaml"), "urls:\n  - mailto://x\n");
  writeFileSync(join(h, "config", "stack.yml"), "version: 1\ncapabilities:\n  llm: openai\n");
}

/** Sorted top-level entry names under a directory. */
function entries(dir: string): string[] {
  return readdirSync(dir).sort();
}

beforeEach(() => {
  prevOpHome = process.env.OP_HOME;
  home = mkdtempSync(join(tmpdir(), "op-migrate-"));
  process.env.OP_HOME = home;
});

afterEach(() => {
  if (prevOpHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = prevOpHome;
  rmSync(home, { recursive: true, force: true });
});

describe("ensureMigrated 0.10 → 0.11", () => {
  it("migrates the vault layout, backs up, and stamps the layout version", () => {
    seed010(home);
    const report = ensureMigrated();

    expect(report.migrated).toBe(true);
    expect(report.from).toBe(0);
    expect(report.to).toBe(CURRENT_LAYOUT_VERSION);
    expect(report.backupDir).toBeTruthy();
    expect(existsSync(report.backupDir!)).toBe(true);

    const stackEnv = readFileSync(join(home, "knowledge", "env", "stack.env"), "utf-8");
    expect(stackEnv).toContain("OP_HOST_UI_PORT=9000"); // renamed
    expect(stackEnv).toContain("OP_TTS_VOICE=alloy");    // prefixed
    expect(stackEnv).toContain("OP_ASSISTANT_PORT=3800"); // kept
    expect(stackEnv).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`); // commit
    expect(stackEnv).not.toContain('OP_RELEASE_VERSION=');
    expect(stackEnv).not.toContain("OPENAI_API_KEY");    // quarantined
    expect(stackEnv).not.toContain("OP_CAP_LLM_MODEL");  // quarantined

    expect(readFileSync(join(home, "knowledge", "env", "stack.env.removed-secrets.bak"), "utf-8"))
      .toContain("OPENAI_API_KEY=sk-secret123");
    expect(readFileSync(join(home, "knowledge", "secrets", "op_ui_login_password"), "utf-8").trim())
      .toBe("hunter2");
    expect(readFileSync(join(home, "knowledge", "secrets", "channel_discord_secret"), "utf-8").trim())
      .toBe("disc-abc");
    expect(readFileSync(join(home, "knowledge", "secrets", "channel_slack_secret"), "utf-8").trim())
      .toBe("slack-xyz");
    expect(existsSync(join(home, "knowledge", "secrets", "some.secret"))).toBe(true);
    expect(existsSync(join(home, "knowledge", "secrets", "apprise.yaml"))).toBe(true);
    // stack.yml is removed in 0.11.0 — the migration must NOT create one.
    expect(existsSync(join(home, "config", "stack", "stack.yml"))).toBe(false);
    expect(readFileSync(join(home, "knowledge", "env", "user.env"), "utf-8")).toContain("MY_PREF=hello");

    // Non-destructive: originals untouched.
    expect(existsSync(join(home, "vault", "stack", "stack.env"))).toBe(true);
  });

  it("ends with exactly the expected 0.11 directories and every datum in its proper location", () => {
    seed010(home);
    ensureMigrated();

    // Only the expected top-level directories exist. The legacy vault/ is
    // intentionally retained (copy-only recovery copy); nothing stray is created.
    expect(entries(home)).toEqual(["config", "data", "knowledge", "vault"]);

    // knowledge/ holds exactly the env + secrets stores.
    expect(entries(join(home, "knowledge"))).toEqual(["env", "secrets"]);

    // Every migrated datum landed in its proper 0.11 location — no missing, no extra.
    expect(entries(join(home, "knowledge", "env"))).toEqual([
      "stack.env",
      "stack.env.removed-secrets.bak",
      "user.env",
    ]);
    expect(entries(join(home, "knowledge", "secrets"))).toEqual([
      "apprise.yaml",
      "channel_discord_secret",
      "channel_slack_secret",
      "op_ui_login_password",
      "some.secret",
    ]);

    // The full backup landed under data/backups (and nowhere else top-level).
    expect(existsSync(join(home, "data", "backups"))).toBe(true);

    // The retained vault/ carries a safe-removal README.
    expect(existsSync(join(home, "vault", "README.md"))).toBe(true);

    // Nothing leaked into a wrong place: no 0.11 secrets under knowledge/env,
    // and no plaintext login password left inside the migrated stack.env.
    expect(existsSync(join(home, "knowledge", "env", "op_ui_login_password"))).toBe(false);
    expect(readFileSync(join(home, "knowledge", "env", "stack.env"), "utf-8"))
      .not.toContain("hunter2");
  });

  it("migrates a minimal home (only stack.env) without creating stray files", () => {
    mkdirSync(join(home, "vault", "stack"), { recursive: true });
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(
      join(home, "vault", "stack", "stack.env"),
      "OP_IMAGE_TAG=0.10.2\nOP_ASSISTANT_PORT=3800\n",
    );
    const report = ensureMigrated();
    expect(report.migrated).toBe(true);

    // env/ has only stack.env — no user.env, no removed-secrets.bak (there were
    // no secrets/cap keys to quarantine).
    expect(entries(join(home, "knowledge", "env"))).toEqual(["stack.env"]);
    // secrets/ exists (created) but is empty — nothing to migrate.
    expect(entries(join(home, "knowledge", "secrets"))).toEqual([]);
    const stackEnv = readFileSync(join(home, "knowledge", "env", "stack.env"), "utf-8");
    expect(stackEnv).toContain("OP_IMAGE_TAG=0.10.2");
    expect(stackEnv).not.toContain('OP_ASSISTANT_IMAGE_TAG=');
    expect(stackEnv).not.toContain('OP_GUARDIAN_IMAGE_TAG=');
    expect(stackEnv).not.toContain('OP_PORTAL_IMAGE_TAG=');
    expect(stackEnv).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);
  });

  it("does not write a removed-secrets.bak when stack.env has no secret/cap keys", () => {
    mkdirSync(join(home, "vault", "stack"), { recursive: true });
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(join(home, "vault", "stack", "stack.env"), "OP_ASSISTANT_PORT=3800\n");
    ensureMigrated();
    expect(existsSync(join(home, "knowledge", "env", "stack.env.removed-secrets.bak"))).toBe(false);
  });

  it("writes a safe-removal README into the retained vault/", () => {
    seed010(home);
    ensureMigrated();
    const readme = readFileSync(join(home, "vault", "README.md"), "utf-8");
    // It explains what the directory is and how to remove it safely.
    expect(readme).toContain("RECOVERY COPY");
    expect(readme).toContain("How to remove it safely");
    expect(readme).toContain("gio trash");
    expect(readme).toContain("data/backups");
    // The original migrated files are still present (README is additive only).
    expect(existsSync(join(home, "vault", "stack", "stack.env"))).toBe(true);
  });

  it("dry-run does not write the vault README", () => {
    seed010(home);
    ensureMigrated({ dryRun: true });
    expect(existsSync(join(home, "vault", "README.md"))).toBe(false);
  });

  it("#499 does not block a normal migration when free space is ample", () => {
    seed010(home);
    // No confirmLowSpace passed — a real temp disk has plenty of free space,
    // so the pre-backup guard must not trip.
    const report = ensureMigrated();
    expect(report.migrated).toBe(true);
    expect(report.backupDir).toBeTruthy();
  });

  it("#499 BackupSpaceError is a MigrationError (so existing handlers catch it)", () => {
    const err = new BackupSpaceError("low space", "guidance", 10, 5);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.estimatedBytes).toBe(10);
    expect(err.freeBytes).toBe(5);
  });

  it("does not clobber a pre-existing vault/README.md", () => {
    seed010(home);
    writeFileSync(join(home, "vault", "README.md"), "user's own notes\n");
    ensureMigrated();
    expect(readFileSync(join(home, "vault", "README.md"), "utf-8")).toBe("user's own notes\n");
  });

  it("converts addons[] from a nested config/stack/stack.yml too", () => {
    seed010(home);
    rmSync(join(home, "config", "stack.yml"), { force: true });
    mkdirSync(join(home, "config", "stack"), { recursive: true });
    writeFileSync(join(home, "config", "stack", "stack.yml"), "version: 2\naddons:\n  - voice\n");
    ensureMigrated();
    expect(readFileSync(join(home, "knowledge", "env", "stack.env"), "utf-8"))
      .toContain("OP_ENABLED_ADDONS=voice");
  });

  it("normalizes channel secret names to lowercase and skips invalid ones", () => {
    mkdirSync(join(home, "vault", "stack"), { recursive: true });
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(join(home, "vault", "stack", "stack.env"), "OP_ASSISTANT_PORT=3800\n");
    writeFileSync(
      join(home, "vault", "stack", "guardian.env"),
      // valid (mixed case → lowercase), and an invalid name with a space (skipped).
      "CHANNEL_Discord_SECRET=abc\nCHANNEL_BAD NAME_SECRET=nope\n",
    );
    ensureMigrated();
    expect(existsSync(join(home, "knowledge", "secrets", "channel_discord_secret"))).toBe(true);
    expect(entries(join(home, "knowledge", "secrets"))).toEqual(["channel_discord_secret"]);
  });

  it("preserves user-edited destination files (copy-only, skip-if-exists)", () => {
    seed010(home);
    // Simulate a partially-migrated home where the user already has a user.env.
    mkdirSync(join(home, "knowledge", "env"), { recursive: true });
    writeFileSync(join(home, "knowledge", "env", "user.env"), "MY_PREF=edited-by-user\n");
    ensureMigrated();
    // The existing destination must NOT be clobbered by the vault copy.
    expect(readFileSync(join(home, "knowledge", "env", "user.env"), "utf-8"))
      .toContain("edited-by-user");
  });

  it("copies auth.json best-effort and surfaces a verify-providers note", () => {
    seed010(home);
    writeFileSync(join(home, "vault", "stack", "auth.json"), '{"openai":{"type":"api"}}');
    const report = ensureMigrated();
    expect(existsSync(join(home, "knowledge", "secrets", "auth.json"))).toBe(true);
    expect(report.notes.join(" ")).toContain("auth.json");
  });

  it("converts a legacy stack.yml addons[] into OP_ENABLED_ADDONS", () => {
    seed010(home);
    writeFileSync(join(home, "config", "stack.yml"), "version: 2\naddons:\n  - voice\n  - discord\n");
    ensureMigrated();
    const stackEnv = readFileSync(join(home, "knowledge", "env", "stack.env"), "utf-8");
    expect(stackEnv).toContain("OP_ENABLED_ADDONS=discord,voice");
    expect(existsSync(join(home, "config", "stack", "stack.yml"))).toBe(false);
  });

  it("is idempotent — a second run is a no-op", () => {
    seed010(home);
    ensureMigrated();
    const second = ensureMigrated();
    expect(second.migrated).toBe(false);
    expect(second.to).toBe(CURRENT_LAYOUT_VERSION);
  });

  it("dry-run writes nothing", () => {
    seed010(home);
    const report = ensureMigrated({ dryRun: true });
    expect(report.migrated).toBe(true);
    expect(existsSync(join(home, "knowledge", "env", "stack.env"))).toBe(false);
    expect(report.backupDir).toBeNull();
  });

  it("aborts (no changes) when the backup cannot be created", () => {
    seed010(home);
    // Make data/ a file so backupOpenPalmHome's mkdir of data/backups fails.
    rmSync(join(home, "data"), { recursive: true, force: true });
    writeFileSync(join(home, "data"), "not a dir");
    expect(() => ensureMigrated()).toThrow(MigrationError);
    expect(existsSync(join(home, "knowledge", "env", "stack.env"))).toBe(false);
  });

  it("treats an already-0.11 home (no vault) as current and stamps it", () => {
    mkdirSync(join(home, "knowledge", "env"), { recursive: true });
    writeFileSync(join(home, "knowledge", "env", "stack.env"), "OP_IMAGE_TAG=v0.11.0\n");
    const report = ensureMigrated();
    expect(report.migrated).toBe(true);
    expect(report.to).toBe(CURRENT_LAYOUT_VERSION);
    const stackEnv = readFileSync(join(home, "knowledge", "env", "stack.env"), "utf-8");
    expect(stackEnv).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);
    expect(stackEnv).not.toContain('OP_ASSISTANT_IMAGE_TAG=');
    expect(stackEnv).toContain('OP_RELEASE_VERSION=0.11.0');
    expect(report.releaseApplied).toEqual([]);
  });

  it('does not stamp OP_RELEASE_VERSION with a non-comparable deployed tag', () => {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'OP_IMAGE_TAG=latest\n');

    const report = ensureMigrated();
    const stackEnv = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');

    expect(report.migrated).toBe(true);
    expect(stackEnv).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);
    expect(stackEnv).not.toContain('OP_RELEASE_VERSION=latest');
    expect(stackEnv).not.toContain('OP_RELEASE_VERSION=');
    expect(report.notes.join(' ')).toContain('Skipped OP_RELEASE_VERSION stamp');
  });

  it('honors opts.homeDir instead of process.env.OP_HOME for every migration path', () => {
    const otherHome = mkdtempSync(join(tmpdir(), 'op-migrate-other-'));
    try {
      mkdirSync(join(otherHome, 'knowledge', 'env'), { recursive: true });
      writeFileSync(join(otherHome, 'knowledge', 'env', 'stack.env'), 'OP_IMAGE_TAG=v0.11.0\n');

      const report = ensureMigrated({ homeDir: otherHome });
      expect(report.migrated).toBe(true);
      expect(readFileSync(join(otherHome, 'knowledge', 'env', 'stack.env'), 'utf-8')).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);
      expect(existsSync(join(home, 'knowledge', 'env', 'stack.env'))).toBe(false);
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it("runs the current release hook only when the upgrade target reaches that version", () => {
    mkdirSync(join(home, "knowledge", "env"), { recursive: true });
    writeFileSync(
      join(home, "knowledge", "env", "stack.env"),
      "OP_IMAGE_TAG=v0.11.0\nOP_RELEASE_VERSION=v0.11.0\n",
    );

    const lowerTarget = ensureReleaseMigrated({ targetVersion: 'v0.11.4' });
    expect(lowerTarget.applied).toEqual([]);
    let stackEnv = readFileSync(join(home, "knowledge", "env", "stack.env"), "utf-8");
    expect(stackEnv).toContain('OP_RELEASE_VERSION=0.11.4');
    expect(stackEnv).not.toContain('OP_ASSISTANT_IMAGE_TAG=');

    const currentTarget = ensureReleaseMigrated({ targetVersion: 'v0.11.5-rc.1' });
    // The v0.11.5-rc.1 migration is pinned to the release that introduced it and
    // still runs (it stamps OP_RELEASE_VERSION). It is now a no-op for image tags:
    // compose resolves every service from OP_IMAGE_TAG, so no per-image vars are
    // written. The per-unit keys remain only as a hand-set escape hatch.
    expect(currentTarget.applied).toEqual(['v0.11.5-rc.1']);
    stackEnv = readFileSync(join(home, "knowledge", "env", "stack.env"), "utf-8");
    expect(stackEnv).toContain('OP_RELEASE_VERSION=0.11.5-rc.1');
    expect(stackEnv).not.toContain('OP_ASSISTANT_IMAGE_TAG=');
    expect(stackEnv).not.toContain('OP_GUARDIAN_IMAGE_TAG=');
    expect(stackEnv).not.toContain('OP_PORTAL_IMAGE_TAG=');
  });

  it('skips stamping a non-comparable explicit release target', () => {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'OP_IMAGE_TAG=v0.11.0\n');

    const report = ensureReleaseMigrated({ targetVersion: 'latest' });
    const stackEnv = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');

    expect(report.migrated).toBe(false);
    expect(report.applied).toEqual([]);
    expect(stackEnv).not.toContain('OP_RELEASE_VERSION=latest');
    expect(stackEnv).not.toContain('OP_RELEASE_VERSION=');
    expect(report.notes.join(' ')).toContain('Skipped OP_RELEASE_VERSION stamp');
  });
});

describe('C4 release migration v0.12.0-rc.1: non-sensitive addon config → stack.env', () => {
  it('copies non-sensitive secret files into stack.env (skip-if-present)', () => {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'OP_IMAGE_TAG=v0.12.0\nOP_RELEASE_VERSION=v0.11.5\n');
    // Non-sensitive key (DISCORD_ALLOWED_GUILDS has no _TOKEN/_SECRET/_PASSWORD/_API_KEY suffix)
    writeFileSync(join(home, 'knowledge', 'secrets', 'discord_allowed_guilds'), '12345,67890\n');
    // Sensitive key (DISCORD_BOT_TOKEN) — must NOT be copied to stack.env
    writeFileSync(join(home, 'knowledge', 'secrets', 'discord_bot_token'), 'Bot.MySecretToken\n');
    // Non-sensitive voice config
    writeFileSync(join(home, 'knowledge', 'secrets', 'op_voice_whisper_model'), 'large\n');
    // A file with a dot in the name should be skipped (not a simple env key)
    writeFileSync(join(home, 'knowledge', 'secrets', 'auth.json'), '{}\n');

    const report = ensureReleaseMigrated({ targetVersion: 'v0.12.0-rc.1' });
    expect(report.migrated).toBe(true);
    expect(report.applied).toContain('v0.12.0-rc.1');

    const stackEnv = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    // Non-sensitive keys copied
    expect(stackEnv).toContain('DISCORD_ALLOWED_GUILDS=12345,67890');
    expect(stackEnv).toContain('OP_VOICE_WHISPER_MODEL=large');
    // Sensitive key NOT copied
    expect(stackEnv).not.toContain('DISCORD_BOT_TOKEN');
    // auth.json skipped (has a dot)
    expect(stackEnv).not.toContain('AUTH.JSON');

    // Source files untouched (never deleted)
    expect(existsSync(join(home, 'knowledge', 'secrets', 'discord_allowed_guilds'))).toBe(true);
    expect(existsSync(join(home, 'knowledge', 'secrets', 'discord_bot_token'))).toBe(true);
  });

  it('NEVER copies non-addon credential files (ssh keys, github/oauth creds) into stack.env', () => {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'OP_IMAGE_TAG=v0.12.0\nOP_RELEASE_VERSION=v0.11.5\n');
    // Real-world general-secret-store files that have NO sensitive suffix but are
    // NOT addon config — must stay out of the non-secret stack.env (allowlist gate).
    writeFileSync(join(home, 'knowledge', 'secrets', 'ssh-key-openpalm-2026-06-10'), '-----BEGIN OPENSSH PRIVATE KEY-----\nXXXX\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'github-itlackey'), 'ghp_REDACTED_TOKEN\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'discord_custom_commands'), 'a,b,c\n'); // not in the schema
    // A legit addon key still gets promoted.
    writeFileSync(join(home, 'knowledge', 'secrets', 'discord_allowed_guilds'), '12345\n');

    ensureReleaseMigrated({ targetVersion: 'v0.12.0-rc.1' });
    const stackEnv = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');

    // The credential / non-schema files must NOT leak into stack.env.
    expect(stackEnv).not.toContain('BEGIN OPENSSH');
    expect(stackEnv).not.toContain('ghp_REDACTED_TOKEN');
    expect(stackEnv).not.toContain('SSH-KEY');
    expect(stackEnv).not.toContain('GITHUB-ITLACKEY');
    expect(stackEnv).not.toContain('DISCORD_CUSTOM_COMMANDS');
    // The declared addon key is still promoted.
    expect(stackEnv).toContain('DISCORD_ALLOWED_GUILDS=12345');
    // Source credential files are left exactly where they were.
    expect(existsSync(join(home, 'knowledge', 'secrets', 'ssh-key-openpalm-2026-06-10'))).toBe(true);
    expect(existsSync(join(home, 'knowledge', 'secrets', 'github-itlackey'))).toBe(true);
  });

  it('skips keys already present in stack.env (idempotent)', () => {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'OP_IMAGE_TAG=v0.12.0\nOP_RELEASE_VERSION=v0.11.5\nDISCORD_ALLOWED_GUILDS=existing\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'discord_allowed_guilds'), 'new-value\n');

    ensureReleaseMigrated({ targetVersion: 'v0.12.0-rc.1' });
    const stackEnv = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    // Existing stack.env value must not be overwritten
    expect(stackEnv).toContain('DISCORD_ALLOWED_GUILDS=existing');
    expect(stackEnv).not.toContain('DISCORD_ALLOWED_GUILDS=new-value');
  });

  it('is idempotent — a second run does not duplicate or alter keys', () => {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'OP_IMAGE_TAG=v0.12.0\nOP_RELEASE_VERSION=v0.11.5\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'discord_allowed_guilds'), '123\n');

    ensureReleaseMigrated({ targetVersion: 'v0.12.0-rc.1' });
    // Call again to verify idempotency of the apply function.
    ensureReleaseMigrated({ targetVersion: 'v0.12.0-rc.1' });
    const afterSecond = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    // stack.env should only contain one occurrence of the key
    const count = (afterSecond.match(/^DISCORD_ALLOWED_GUILDS=/mg) ?? []).length;
    expect(count).toBe(1);
  });

  it('is copy-only — no source secret file is deleted', () => {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'OP_IMAGE_TAG=v0.12.0\nOP_RELEASE_VERSION=v0.11.5\n');
    const files = ['discord_allowed_guilds', 'op_voice_whisper_model', 'slack_allowed_channels'];
    for (const f of files) {
      writeFileSync(join(home, 'knowledge', 'secrets', f), 'somevalue\n');
    }

    ensureReleaseMigrated({ targetVersion: 'v0.12.0-rc.1' });

    for (const f of files) {
      expect(existsSync(join(home, 'knowledge', 'secrets', f))).toBe(true);
    }
  });

  it('skips non-sensitive migration when secrets dir does not exist', () => {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'OP_IMAGE_TAG=v0.12.0\nOP_RELEASE_VERSION=v0.11.5\n');
    // No knowledge/secrets/ dir at all
    const report = ensureReleaseMigrated({ targetVersion: 'v0.12.0-rc.1' });
    expect(report.migrated).toBe(true);
    expect(report.applied).toContain('v0.12.0-rc.1');
  });

  it('does not apply migration when target version predates v0.12.0-rc.1', () => {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'OP_IMAGE_TAG=v0.11.0\nOP_RELEASE_VERSION=v0.11.0\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'discord_allowed_guilds'), '123\n');

    ensureReleaseMigrated({ targetVersion: 'v0.11.9' });
    const stackEnv = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    expect(stackEnv).not.toContain('DISCORD_ALLOWED_GUILDS');
  });
});

describe('release migration v0.12.0-rc.1: channel_*_secret → portal_*_secret', () => {
  it('renames per-portal verification secrets to the portal_ prefix', () => {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'OP_IMAGE_TAG=v0.12.0\nOP_RELEASE_VERSION=v0.11.5\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'channel_discord_secret'), 'disc-abc\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'channel_slack_secret'), 'slack-xyz\n');
    // A non-portal secret must be left untouched.
    writeFileSync(join(home, 'knowledge', 'secrets', 'discord_bot_token'), 'Bot.token\n');

    const report = ensureReleaseMigrated({ targetVersion: 'v0.12.0-rc.1' });
    expect(report.migrated).toBe(true);
    expect(report.applied).toContain('v0.12.0-rc.1');

    // Renamed (value preserved), originals gone.
    expect(readFileSync(join(home, 'knowledge', 'secrets', 'portal_discord_secret'), 'utf-8').trim()).toBe('disc-abc');
    expect(readFileSync(join(home, 'knowledge', 'secrets', 'portal_slack_secret'), 'utf-8').trim()).toBe('slack-xyz');
    expect(existsSync(join(home, 'knowledge', 'secrets', 'channel_discord_secret'))).toBe(false);
    expect(existsSync(join(home, 'knowledge', 'secrets', 'channel_slack_secret'))).toBe(false);
    // Non-portal secret untouched.
    expect(existsSync(join(home, 'knowledge', 'secrets', 'discord_bot_token'))).toBe(true);
  });

  it('skips when the portal_ name already exists (idempotent, no clobber)', () => {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'OP_IMAGE_TAG=v0.12.0\nOP_RELEASE_VERSION=v0.11.5\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'channel_discord_secret'), 'old\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'portal_discord_secret'), 'already-here\n');

    ensureReleaseMigrated({ targetVersion: 'v0.12.0-rc.1' });
    // Existing portal_ value is preserved (not clobbered by the channel_ copy).
    expect(readFileSync(join(home, 'knowledge', 'secrets', 'portal_discord_secret'), 'utf-8').trim()).toBe('already-here');
  });
});

describe('release migration v0.12.0-rc.1: channel_lan → portal_net in custom.compose.yml', () => {
  function seedRelease(): void {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(home, 'config', 'stack'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'),
      'OP_IMAGE_TAG=v0.12.0\nOP_RELEASE_VERSION=v0.11.5\n');
  }

  it('rewrites channel_lan references and backs up the original overlay', () => {
    seedRelease();
    const customPath = join(home, 'config', 'stack', 'custom.compose.yml');
    const original =
      'services:\n  myapp:\n    image: me/app\n    networks: [channel_lan]\nnetworks:\n  channel_lan:\n';
    writeFileSync(customPath, original);

    const report = ensureReleaseMigrated({ targetVersion: 'v0.12.0-rc.1' });
    expect(report.applied).toContain('v0.12.0-rc.1');

    const rewritten = readFileSync(customPath, 'utf-8');
    expect(rewritten).not.toContain('channel_lan');
    expect(rewritten).toContain('networks: [portal_net]');
    expect(rewritten).toContain('  portal_net:');

    // Original preserved as a backup sibling.
    expect(readFileSync(`${customPath}.pre-portal-rename.bak`, 'utf-8')).toBe(original);
  });

  it('is a no-op when the overlay does not reference channel_lan (no backup written)', () => {
    seedRelease();
    const customPath = join(home, 'config', 'stack', 'custom.compose.yml');
    const original = 'services: {}\n';
    writeFileSync(customPath, original);

    ensureReleaseMigrated({ targetVersion: 'v0.12.0-rc.1' });

    expect(readFileSync(customPath, 'utf-8')).toBe(original);
    expect(existsSync(`${customPath}.pre-portal-rename.bak`)).toBe(false);
  });

  it('does not clobber an existing backup on a second run', () => {
    seedRelease();
    const customPath = join(home, 'config', 'stack', 'custom.compose.yml');
    writeFileSync(customPath, 'networks:\n  channel_lan:\n');
    writeFileSync(`${customPath}.pre-portal-rename.bak`, 'PRIOR-BACKUP\n');

    ensureReleaseMigrated({ targetVersion: 'v0.12.0-rc.1' });

    // Rewrite still happens, but the pre-existing backup is preserved.
    expect(readFileSync(customPath, 'utf-8')).not.toContain('channel_lan');
    expect(readFileSync(`${customPath}.pre-portal-rename.bak`, 'utf-8')).toBe('PRIOR-BACKUP\n');
  });
});

describe('layout migration 1 → 2: drop inert pre-0.12.0 system files', () => {
  function seedV1(): void {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
    mkdirSync(join(home, 'config', 'stack'), { recursive: true });
    mkdirSync(join(home, 'data'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'OP_LAYOUT_VERSION=1\nOP_IMAGE_TAG=v0.11.5\n');
    // Inert SYSTEM files — must be removed.
    writeFileSync(join(home, 'config', 'stack', 'channels.compose.yml'), 'services: {}\n');
    writeFileSync(join(home, 'config', 'stack', 'stack.yml'), 'version: 2\n');
    // Managed + user files — must be KEPT.
    writeFileSync(join(home, 'config', 'stack', 'core.compose.yml'), 'services:\n  guardian: {}\n');
    writeFileSync(join(home, 'config', 'stack', 'custom.compose.yml'), 'services: {}\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'ssh-key-mine'), 'PRIVATE\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'discord_bot_token'), 'tok\n');
  }

  it('removes inert system files BACKUP-FIRST, keeps managed + user data, stamps v2', () => {
    seedV1();
    const report = ensureMigrated();

    expect(report.migrated).toBe(true);
    expect(report.from).toBe(1);
    expect(report.to).toBe(2);
    // A FULL OP_HOME backup is taken before anything is removed.
    expect(report.backupDir).toBeTruthy();
    expect(existsSync(report.backupDir!)).toBe(true);
    // ...and the removed file is recoverable from that backup.
    expect(existsSync(join(report.backupDir!, 'config', 'stack', 'channels.compose.yml'))).toBe(true);

    // Inert system files are gone.
    expect(existsSync(join(home, 'config', 'stack', 'channels.compose.yml'))).toBe(false);
    expect(existsSync(join(home, 'config', 'stack', 'stack.yml'))).toBe(false);
    // Managed + user data preserved — never deleted.
    expect(existsSync(join(home, 'config', 'stack', 'core.compose.yml'))).toBe(true);
    expect(existsSync(join(home, 'config', 'stack', 'custom.compose.yml'))).toBe(true);
    expect(existsSync(join(home, 'knowledge', 'secrets', 'ssh-key-mine'))).toBe(true);
    expect(existsSync(join(home, 'knowledge', 'secrets', 'discord_bot_token'))).toBe(true);
    // Layout version committed.
    expect(readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8')).toContain('OP_LAYOUT_VERSION=2');
  });

  it('is a no-op when already at layout v2 (idempotent)', () => {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(home, 'config', 'stack'), { recursive: true });
    mkdirSync(join(home, 'data'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'OP_LAYOUT_VERSION=2\nOP_RELEASE_VERSION=v0.12.0-rc.4\n');
    const report = ensureMigrated();
    expect(report.migrated).toBe(false);
  });
});

describe('release migration v0.12.3-rc.1: purge stale addon IDs from OP_ENABLED_ADDONS', () => {
  function seedEnv(addonLine: string): void {
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    writeFileSync(
      join(home, 'knowledge', 'env', 'stack.env'),
      `OP_IMAGE_TAG=v0.12.2\nOP_RELEASE_VERSION=v0.12.2\n${addonLine}\n`,
    );
  }

  it('removes stale addon IDs while preserving valid ones', () => {
    seedEnv('OP_ENABLED_ADDONS=discord,oldaddon,voice,legacychannel');

    const report = ensureReleaseMigrated({ targetVersion: 'v0.12.3-rc.1' });
    expect(report.migrated).toBe(true);
    expect(report.applied).toContain('v0.12.3-rc.1');

    const stackEnv = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    expect(stackEnv).toContain('OP_ENABLED_ADDONS=discord,voice');
    expect(stackEnv).not.toContain('oldaddon');
    expect(stackEnv).not.toContain('legacychannel');
  });

  it('is a no-op when all addon IDs are valid (already clean)', () => {
    seedEnv('OP_ENABLED_ADDONS=discord,voice');

    ensureReleaseMigrated({ targetVersion: 'v0.12.3-rc.1' });
    const stackEnv = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    expect(stackEnv).toContain('OP_ENABLED_ADDONS=discord,voice');
  });

  it('is a no-op when OP_ENABLED_ADDONS is absent', () => {
    seedEnv('OP_HOST_UI_PORT=8100');

    const before = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    ensureReleaseMigrated({ targetVersion: 'v0.12.3-rc.1' });
    const after = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    expect(after).not.toContain('OP_ENABLED_ADDONS');
    expect(after).toContain('OP_RELEASE_VERSION=0.12.3-rc.1');
  });

  it('sets OP_ENABLED_ADDONS to empty string when all IDs are stale', () => {
    seedEnv('OP_ENABLED_ADDONS=oldchannel,removedaddon');

    ensureReleaseMigrated({ targetVersion: 'v0.12.3-rc.1' });
    const stackEnv = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    expect(stackEnv).toContain('OP_ENABLED_ADDONS=');
    expect(stackEnv).not.toContain('oldchannel');
    expect(stackEnv).not.toContain('removedaddon');
  });

  it('is idempotent — a second run does not alter the result', () => {
    seedEnv('OP_ENABLED_ADDONS=discord,stale,voice');

    ensureReleaseMigrated({ targetVersion: 'v0.12.3-rc.1' });
    ensureReleaseMigrated({ targetVersion: 'v0.12.3-rc.1' });
    const stackEnv = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    const count = (stackEnv.match(/^OP_ENABLED_ADDONS=/mg) ?? []).length;
    expect(count).toBe(1);
    expect(stackEnv).toContain('OP_ENABLED_ADDONS=discord,voice');
  });

  it('dry-run reports stale IDs without writing', () => {
    seedEnv('OP_ENABLED_ADDONS=discord,phantom,voice');
    const before = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');

    ensureReleaseMigrated({ targetVersion: 'v0.12.3-rc.1', dryRun: true });
    const after = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    // dry-run must not write anything
    expect(after).toBe(before);
  });

  it('does not apply when target version predates v0.12.3-rc.1', () => {
    seedEnv('OP_ENABLED_ADDONS=discord,stale,voice');

    ensureReleaseMigrated({ targetVersion: 'v0.12.2' });
    const stackEnv = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    // stale ID still present — migration was not run
    expect(stackEnv).toContain('OP_ENABLED_ADDONS=discord,stale,voice');
  });
});

describe('M2: readLayoutVersion case 4 — pre-stamp 0.11.0 home runs 1→2 migration', () => {
  it('stamps CURRENT_LAYOUT_VERSION=2 and runs the 1→2 layout migration for a pre-stamp 0.11.0 home', () => {
    // A home that has knowledge/env/stack.env but no OP_LAYOUT_VERSION stamp
    // and no vault/ — the "0.11.0 installed before the stamp was added" case.
    // Fix (M2): readLayoutVersion must return 1 (not CURRENT_LAYOUT_VERSION) so
    // the 1→2 migration runs (removing inert pre-0.12.0 system files).
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(home, 'config', 'stack'), { recursive: true });
    mkdirSync(join(home, 'data'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'OP_IMAGE_TAG=v0.11.5\n');
    // Plant an inert system file that the 1→2 migration removes.
    writeFileSync(join(home, 'config', 'stack', 'channels.compose.yml'), 'services: {}\n');

    const report = ensureMigrated();

    expect(report.migrated).toBe(true);
    expect(report.from).toBe(1);
    expect(report.to).toBe(CURRENT_LAYOUT_VERSION);

    const stackEnv = readFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'utf-8');
    expect(stackEnv).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);

    // The 1→2 migration must have run — channels.compose.yml is an inert system file.
    expect(existsSync(join(home, 'config', 'stack', 'channels.compose.yml'))).toBe(false);
  });
});

describe('RELEASE_MIGRATIONS uniqueness', () => {
  it('has no duplicate describe strings in RELEASE_MIGRATIONS', () => {
    const versions = releaseMigrationVersions();
    // releaseMigrationVersions() returns one entry per migration in order.
    // Use selectPendingReleaseMigrations with a far-future target to obtain the
    // full list, and check describes via the exported versions + internal shape.
    // Since we only export versions here, check there are no duplicate (version, describe)
    // pairs by running the selector for a target beyond all known versions.
    const all = selectPendingReleaseMigrations(null, 'v99.0.0');
    const describes = all.map((m) => m.describe);
    const unique = new Set(describes);
    expect(unique.size).toBe(describes.length);
  });
});
