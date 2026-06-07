import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMigrated, MigrationError, CURRENT_LAYOUT_VERSION } from "./migrations.js";

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
    writeFileSync(join(home, "knowledge", "env", "stack.env"), "OP_IMAGE_TAG=0.11.0\n");
    const report = ensureMigrated();
    expect(report.migrated).toBe(false);
    expect(report.to).toBe(CURRENT_LAYOUT_VERSION);
    expect(readFileSync(join(home, "knowledge", "env", "stack.env"), "utf-8"))
      .toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);
  });
});
