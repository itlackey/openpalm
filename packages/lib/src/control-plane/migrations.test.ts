import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMigrated, ensureReleaseMigrated, MigrationError, CURRENT_LAYOUT_VERSION } from "./migrations.js";

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
    expect(stackEnv).not.toContain('OP_CHANNEL_IMAGE_TAG=');
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
    expect(stackEnv).toContain('OP_RELEASE_VERSION=v0.11.0');
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
    expect(stackEnv).toContain('OP_RELEASE_VERSION=v0.11.4');
    expect(stackEnv).not.toContain('OP_ASSISTANT_IMAGE_TAG=');

    const currentTarget = ensureReleaseMigrated({ targetVersion: 'v0.11.5-rc.1' });
    // The per-image-tag migration is pinned to the release that introduced it.
    expect(currentTarget.applied).toEqual(['v0.11.5-rc.1']);
    stackEnv = readFileSync(join(home, "knowledge", "env", "stack.env"), "utf-8");
    expect(stackEnv).toContain('OP_RELEASE_VERSION=v0.11.5-rc.1');
    expect(stackEnv).toContain('OP_ASSISTANT_IMAGE_TAG=v0.11.0');
    expect(stackEnv).toContain('OP_GUARDIAN_IMAGE_TAG=v0.11.0');
    expect(stackEnv).toContain('OP_CHANNEL_IMAGE_TAG=v0.11.0');
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
