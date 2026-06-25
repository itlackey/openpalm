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
import {
  ensureMigrated, ensureReleaseMigrated, CURRENT_LAYOUT_VERSION,
  selectPendingLayoutMigrations, selectPendingReleaseMigrations,
  releaseMigrationVersions, UnrecognizedLayoutError,
} from "./migrations.js";
import { isComparableSemver } from "./versioning.js";

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
      // The USER custom overlay stays in config/stack; its channel_lan→portal_net
      // backup sibling is written here too.
      "config/stack/custom.compose.yml",
      "config/stack/custom.compose.yml.pre-portal-rename.bak",
      // core/services.compose.yml are GONE from config/stack — managed files moved
      // to system/stack (layout v2→v3); they self-heal there on the next reconcile
      // and are recoverable from the full-home backup.
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
    expect(env).toContain("OP_RELEASE_VERSION=0.12.0-rc.5");
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

    // The inert + orphaned-managed files are recoverable from the full-home backup.
    expect(existsSync(join(layout.backupDir!, "config", "stack", "channels.compose.yml"))).toBe(true);
    expect(existsSync(join(layout.backupDir!, "config", "stack", "stack.yml"))).toBe(true);
    expect(existsSync(join(layout.backupDir!, "config", "stack", "core.compose.yml"))).toBe(true);
    expect(existsSync(join(layout.backupDir!, "config", "stack", "services.compose.yml"))).toBe(true);

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

// ── Forward-compatibility invariants: the engine must keep handling multi-version
//    jumps as new migrations are added. These FAIL at CI the moment a future
//    migration breaks the chain — long before it could reach a user's disk. ─────
describe("forward-compat: migration engine handles any version jump", () => {
  it("layout migrations form an unbroken chain from 0 to CURRENT_LAYOUT_VERSION", () => {
    // selectPendingLayoutMigrations throws on a gap; reaching here means it walked
    // 0 → … → CURRENT contiguously. Assert each step advances and lands exactly.
    const chain = selectPendingLayoutMigrations(0);
    let cursor = 0;
    for (const m of chain) {
      expect(m.from).toBe(cursor); // no gap, no out-of-order step
      cursor = m.to;
    }
    expect(cursor).toBe(CURRENT_LAYOUT_VERSION); // ends exactly at the ceiling
  });

  it("every intermediate start version chains all the way to current", () => {
    // A home at ANY past layout version must reach CURRENT — this is what makes a
    // multi-version jump apply all intermediate migrations.
    for (let from = 0; from <= CURRENT_LAYOUT_VERSION; from++) {
      const chain = selectPendingLayoutMigrations(from);
      const reached = chain.reduce((cur, m) => (expect(m.from).toBe(cur), m.to), from);
      expect(reached).toBe(CURRENT_LAYOUT_VERSION);
    }
  });

  it("is a forward-only no-op at or beyond the current layout", () => {
    expect(selectPendingLayoutMigrations(CURRENT_LAYOUT_VERSION)).toEqual([]);
    expect(selectPendingLayoutMigrations(CURRENT_LAYOUT_VERSION + 5)).toEqual([]);
  });

  it("every release migration is pinned to a comparable semver version", () => {
    // A typo'd / non-comparable version string makes selectPendingReleaseMigrations
    // silently skip that migration forever — catch it here instead.
    const versions = releaseMigrationVersions();
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect(isComparableSemver(v)).toBe(true);
    }
  });
});

// ── Forward-compat ERGONOMICS: a new release only adds the single previous→current
//    step. Simulates the NEXT release adding one migration and proves a home at ANY
//    older version still chains all the way up — the developer never reasons about,
//    or even reads, the migrations for releases before the immediately-previous one.
describe("forward-compat: a new release only authors the previous→current step", () => {
  // The selectors read only from/to (layout) and version (release); apply/verify are
  // never invoked during selection, so minimal stubs suffice.
  const layoutStep = (from: number, to: number) =>
    ({ from, to, describe: "", apply: () => {}, verify: () => {} });
  const releaseStep = (version: string) =>
    ({ version, describe: "", apply: () => {}, verify: () => {} });

  it("LAYOUT: adding {from:N,to:N+1} + bumping the ceiling chains every older home", () => {
    // Today's real chain is 0→1→2. Simulate the NEXT release: the developer adds
    // exactly ONE entry (2→3) and bumps the ceiling to 3 — nothing else changes.
    const TODAY = [layoutStep(0, 1), layoutStep(1, 2)];
    const NEXT = [...TODAY, layoutStep(2, 3)]; // the only authored change
    const CEIL = 3;

    // A home at ANY older version reaches the new ceiling, applying every step.
    for (let from = 0; from <= CEIL; from++) {
      const chain = selectPendingLayoutMigrations(from, NEXT, CEIL);
      const reached = chain.reduce((cur, m) => (expect(m.from).toBe(cur), m.to), from);
      expect(reached).toBe(CEIL);
    }
    // A previous-release (layout-2) home runs ONLY the newly authored step.
    expect(selectPendingLayoutMigrations(2, NEXT, CEIL).map((m) => `${m.from}->${m.to}`))
      .toEqual(["2->3"]);
    // A 0.9.x-era (layout-0) home still gets all three — unchanged history first.
    expect(selectPendingLayoutMigrations(0, NEXT, CEIL).map((m) => `${m.from}->${m.to}`))
      .toEqual(["0->1", "1->2", "2->3"]);
  });

  it("RELEASE: adding a vNext entry applies it for every older recorded version", () => {
    // Today's pinned versions + ONE new entry the developer adds for the next release.
    const TODAY = ["v0.11.5-rc.1", "v0.12.0-rc.1"].map(releaseStep);
    const NEXT = [...TODAY, releaseStep("v0.13.0")]; // the only authored change
    const picked = (rel: string | null, target: string) =>
      selectPendingReleaseMigrations(rel, target, NEXT).map((m) => m.version);

    // A home recorded at the PREVIOUS release runs only the newly added step.
    expect(picked("v0.12.0", "v0.13.0")).toEqual(["v0.13.0"]);
    // An older home gets every intermediate migration up to the target, in order
    // (v0.11.5-rc.1 < v0.11.5, so a v0.11.5 home runs the 0.12 + 0.13 steps).
    expect(picked("v0.11.5", "v0.13.0")).toEqual(["v0.12.0-rc.1", "v0.13.0"]);
    // An even older / no recorded version runs them all (they are idempotent).
    expect(picked("v0.11.0", "v0.13.0")).toEqual(["v0.11.5-rc.1", "v0.12.0-rc.1", "v0.13.0"]);
    expect(picked(null, "v0.13.0")).toEqual(["v0.11.5-rc.1", "v0.12.0-rc.1", "v0.13.0"]);
    // The migration pinned to the target runs when upgrading TO it (inclusive bound).
    expect(picked("v0.12.5", "v0.13.0")).toContain("v0.13.0");
  });

  it("DETECTION is frozen: a previous-release home is stamped, so no new marker is needed", () => {
    // The reason a developer never touches OLD layouts: a home from the
    // immediately-previous release carries an authoritative OP_LAYOUT_VERSION
    // stamp, so detection returns it directly. The heuristic legacy markers
    // (vault/, config/system.env) are consulted ONLY for pre-stamp homes — a
    // closed historical set that never grows with new releases.
    seed({ "knowledge/env/stack.env": `OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}\n` });
    const report = ensureMigrated();
    expect(report.from).toBe(CURRENT_LAYOUT_VERSION); // read straight from the stamp
    expect(report.migrated).toBe(false);
  });
});

// ── Invariant harness: run MANY messy homes through one battery of properties ───
//
// De-brittles the engine empirically: instead of hand-checking each fixture, every
// generated home must satisfy the SAME invariants — reaches current, backs up,
// leaks no secret into stack.env, is idempotent, and loses NO user data (every
// seeded file is either still present, relocated verbatim, or — for intentionally
// removed inert system files — recoverable from the backup). Adding a layout =
// add a case and inherit the whole battery. All secrets here are SYNTHETIC.
describe("invariant harness: messy homes satisfy migration properties", () => {
  const TARGET = "v0.12.0-rc.6";
  // Every synthetic secret value used below — none may appear in the non-secret stack.env.
  const SECRETS = [
    "hunter2", "gsk-FAKE", "sk-FAKE-NOT-REAL", "svc-secret-FAKE",
    "disc-abc", "slack-xyz", "disc-sec", "Bot.SECRET", "ghp_REDACTED",
  ];

  interface HomeCase {
    name: string;
    seed: Record<string, string>;
    recognized: boolean;            // reaches the current layout stamp
    intentionallyRemoved?: string[]; // inert SYSTEM files removed (recoverable from backup only)
  }

  const CASES: HomeCase[] = [
    {
      name: "0.9.x minimal (system.env + user.env only)",
      recognized: true,
      seed: {
        "config/system.env": "OP_ADMIN_PORT=8100\nOP_UI_LOGIN_PASSWORD=hunter2\nGROQ_API_KEY=gsk-FAKE\n",
        "config/user.env": "MY_PREF=hi\n",
      },
    },
    {
      name: "0.9.x automations + components only",
      recognized: true,
      seed: {
        "config/system.env": "OP_KEEP=1\n",
        "config/automations/a.yml": "id: a\n",
        "config/automations/b.yml": "id: b\n",
        "config/components/channel-discord.yml": "services: {}\n",
        "config/components/junk.bin": "\x00\x01\n",
      },
    },
    {
      name: "0.10.x minimal vault (stack.env only)",
      recognized: true,
      seed: {
        "vault/stack/stack.env": "OP_ADMIN_PORT=9000\nOP_UI_LOGIN_PASSWORD=hunter2\n",
      },
    },
    {
      name: "0.10.x vault with services + credential dir",
      recognized: true,
      seed: {
        "vault/user/user.env": "X=1\n",
        "vault/stack/stack.env": "SOME_API_KEY=sk-FAKE-NOT-REAL\nOP_KEEP=1\n",
        "vault/stack/guardian.env": "CHANNEL_DISCORD_SECRET=disc-abc\n",
        "vault/stack/services/svc_key": "svc-secret-FAKE\n",
        "vault/user/.gcloud/creds.json": '{"k":"v"}\n',
      },
    },
    {
      name: "0.11.x channels (channel_* secrets + addon config) — inert files removed",
      recognized: true,
      // core.compose.yml is a MANAGED file removed from config/stack by layout v2→v3
      // (it self-heals at system/stack on reconcile; recoverable from the backup).
      intentionallyRemoved: ["config/stack/channels.compose.yml", "config/stack/stack.yml", "config/stack/core.compose.yml"],
      seed: {
        "knowledge/env/stack.env": "OP_LAYOUT_VERSION=1\nOP_IMAGE_TAG=v0.11.5\nOP_RELEASE_VERSION=v0.11.5\n",
        "knowledge/secrets/channel_discord_secret": "disc-sec\n",
        "knowledge/secrets/discord_bot_token": "Bot.SECRET\n",
        "knowledge/secrets/discord_application_id": "12345\n",
        "knowledge/secrets/github-itlackey": "ghp_REDACTED\n",
        "config/stack/channels.compose.yml": "services: {}\n",
        "config/stack/stack.yml": "version: 2\n",
        "config/stack/core.compose.yml": "services: {}\n",
      },
    },
    {
      name: "0.11.x pre-stamp (stack.env, no OP_LAYOUT_VERSION)",
      recognized: true,
      // core.compose.yml is removed from config/stack by layout v2→v3 (managed →
      // system/stack); recoverable from the backup.
      intentionallyRemoved: ["config/stack/core.compose.yml"],
      seed: {
        "knowledge/env/stack.env": "OP_IMAGE_TAG=v0.11.0\nOP_KEEP=1\n",
        "config/stack/core.compose.yml": "services: {}\n",
      },
    },
  ];

  function liveContentSet(): Set<string> {
    const set = new Set<string>();
    for (const [rel, content] of Object.entries(snapshot())) {
      if (rel === "data/backups/") continue;
      set.add(content);
    }
    return set;
  }

  for (const c of CASES) {
    it(`${c.name}: reaches current, no leak, idempotent, no data loss`, () => {
      seed(c.seed);
      const { layout } = runUpgrade(TARGET);

      // Reaches the current layout, backed up first.
      if (c.recognized) expect(readEnv()).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);
      if (layout.migrated) {
        expect(layout.backupDir).toBeTruthy();
        expect(existsSync(layout.backupDir!)).toBe(true);
      }

      // No synthetic secret ever lands in the non-secret stack.env.
      const env = readEnv();
      for (const s of SECRETS) expect(env.includes(s)).toBe(false);

      // No data loss: each seeded file is present, relocated verbatim, or (inert)
      // intentionally removed but recoverable from the backup.
      const live = liveContentSet();
      for (const [rel, content] of Object.entries(c.seed)) {
        if (c.intentionallyRemoved?.includes(rel)) {
          expect(existsSync(join(home, rel))).toBe(false);                  // gone from live tree
          expect(existsSync(join(layout.backupDir!, rel))).toBe(true);      // recoverable from backup
          continue;
        }
        const stillThere = existsSync(join(home, rel)); // untouched or amended in place
        const relocated = live.has(content);            // copied/relocated verbatim elsewhere
        expect(stillThere || relocated).toBe(true);
      }

      // Idempotent: a second upgrade run changes nothing.
      const after1 = snapshot(); delete after1["data/backups/"];
      const second = runUpgrade(TARGET);
      expect(second.layout.migrated).toBe(false);
      const after2 = snapshot(); delete after2["data/backups/"];
      expect(after2).toEqual(after1);
    });
  }
});

// ── Fail-loud detection: an unrecognized home must REFUSE, not silently pass ─────
describe("fail-loud: unrecognized layout is refused without modifying anything", () => {
  it("throws UnrecognizedLayoutError on a content home matching no known layout", () => {
    // Content present (config/ + data/) but no stamp, no vault/, no config/system.env,
    // no knowledge/env/stack.env — exactly the shape the silent 'assume current'
    // catch-all used to mislabel (this is what hid the 0.9.x gap).
    seed({
      "config/some-future-thing.yml": "version: 99\n",
      "data/assistant/state.db": "blob\n",
    });
    const before = snapshot();

    expect(() => ensureMigrated()).toThrow(UnrecognizedLayoutError);

    // NOTHING was modified — detection refuses before taking the lock/backup.
    expect(snapshot()).toEqual(before);
  });

  it("does NOT throw on a fresh, empty home (treats it as current)", () => {
    // No content at all → fresh install → current layout, no error.
    expect(() => ensureMigrated()).not.toThrow();
  });
});

// ── Scenario 2a: 0.10.x vault/ "hellscape" → 0.12.0 (layout 0 → 1 → 2) ───────────
//
// A deliberately MESSY 0.10.x vault home: env with a login password + secrets and
// a capability key that must be quarantined, per-service secret files, guardian
// CHANNEL_*_SECRET entries, credential files/dirs, a legacy stack.yml driving
// addons, inert pre-0.12 compose files, and assorted junk inside vault/. After
// upgrade everything must be organized: data extracted into knowledge/ (and the
// channel_*→portal_* 0.12 rename applied), inert system files removed, vault/
// fully retained as a recovery copy, and user data/logs/backups untouched.
//
// NOTE: every secret below is SYNTHETIC (no real credentials in fixtures).
describe("scenario: 0.10.x vault hellscape → 0.12.0", () => {
  function seed010Hellscape(): void {
    seed({
      // vault/user — preferences + credential file + credential dir + junk
      "vault/user/user.env": "MY_PREF=hello\nEDITOR=vim\n",
      "vault/user/apprise.yaml": "urls: []\n",
      "vault/user/.gcloud/credentials.json": '{"fake":true}\n', // SYNTHETIC credential dir
      "vault/user/notes.txt": "my private notes - keep\n",       // junk: retained in vault/, not extracted
      // vault/stack/stack.env — ports renamed/dropped, password + secrets quarantined
      "vault/stack/stack.env": [
        "OP_ADMIN_PORT=8100",          // → renamed OP_HOST_UI_PORT
        "OP_GUARDIAN_PORT=8180",       // → dropped (removed var)
        "OP_UI_LOGIN_PASSWORD=hunter2", // → extracted to knowledge/secrets/ (SYNTHETIC)
        "GROQ_API_KEY=gsk-FAKE",       // → quarantined to .removed-secrets.bak (SYNTHETIC)
        "OP_CAP_LLM=openai",           // → quarantined (capability key)
        "OP_ASSISTANT_PORT=3800",      // → kept
        "TTS_VOICE=bf_isabella",       // → renamed OP_TTS_VOICE
        "",
      ].join("\n"),
      // vault/stack — guardian channel secrets, auth, per-service secret, junk
      "vault/stack/guardian.env": "CHANNEL_DISCORD_SECRET=disc-abc\nCHANNEL_SLACK_SECRET=slack-xyz\n", // SYNTHETIC
      "vault/stack/auth.json": "{}\n",
      "vault/stack/services/memory_db_key": "svc-secret-FAKE\n", // SYNTHETIC per-service secret
      "vault/stack/.DS_Store": "junk\n",                          // junk: retained in vault/, not extracted
      // legacy stack.yml drives addons (consumed for OP_ENABLED_ADDONS, then removed by v2)
      "config/stack/stack.yml": "version: 1\naddons:\n  - discord\n  - slack\n",
      "config/stack/channels.compose.yml": "services: {}\n", // inert → removed by v2
      "config/stack/core.compose.yml": "services:\n  guardian: {}\n", // managed → kept
      "config/assistant/persona.md": "you are helpful\n",     // user config → untouched
      // user data / service data / logs / old backups — must be UNTOUCHED
      "data/assistant/.keep": "",
      "data/stash/memory.db": "sqlite\n",
      "logs/assistant.log": "boot ok\n",
      "backups/old.tgz": "tar\n",
    });
  }

  it("organizes the 0.10.x vault home into the v2 layout and retains vault/", () => {
    seed010Hellscape();
    const { layout } = runUpgrade("v0.12.0-rc.5");

    expect(layout.from).toBe(0);
    expect(layout.to).toBe(CURRENT_LAYOUT_VERSION); // 0 → 1 → 2
    expect(layout.backupDir).toBeTruthy();
    expect(existsSync(layout.backupDir!)).toBe(true);

    // EXACT resulting file set: data extracted to knowledge/ (channel→portal
    // renamed), inert files removed, vault/ fully retained, data/logs/backups
    // untouched. Nothing deleted.
    expect(fileSet()).toEqual([
      "backups/old.tgz",                                  // old top-level backups — UNTOUCHED
      "config/assistant/persona.md",                      // user config — UNTOUCHED
      // config/stack/core.compose.yml GONE — managed compose moved to system/stack
      // (layout v2→v3); self-heals there on reconcile, recoverable from backup.
      // config/stack/{stack.yml,channels.compose.yml} GONE (inert, removed by v2)
      "data/assistant/.keep",                             // service data — UNTOUCHED
      "data/backups/",
      "data/stash/memory.db",
      "knowledge/env/stack.env",                          // extracted into the new knowledge/ layout
      "knowledge/env/stack.env.removed-secrets.bak",
      "knowledge/env/user.env",
      "knowledge/secrets/.gcloud/credentials.json",       // credential dir copied (recursive)
      "knowledge/secrets/apprise.yaml",
      "knowledge/secrets/auth.json",
      "knowledge/secrets/memory_db_key",                  // per-service secret
      "knowledge/secrets/op_ui_login_password",
      "knowledge/secrets/portal_discord_secret",          // channel_→portal_ (0.12 rename)
      "knowledge/secrets/portal_slack_secret",
      "logs/assistant.log",                               // logs — UNTOUCHED
      "vault/README.md",                                  // vault/ RETAINED as a recovery copy
      "vault/stack/.DS_Store",
      "vault/stack/auth.json",
      "vault/stack/guardian.env",
      "vault/stack/services/memory_db_key",
      "vault/stack/stack.env",
      "vault/user/.gcloud/credentials.json",
      "vault/user/apprise.yaml",
      "vault/user/notes.txt",
      "vault/user/user.env",
    ]);

    const env = readEnv();
    expect(env).toContain("OP_HOST_UI_PORT=8100");      // OP_ADMIN_PORT renamed
    expect(env).not.toContain("OP_GUARDIAN_PORT");      // removed var dropped
    expect(env).toContain("OP_ASSISTANT_PORT=3800");    // unknown key kept
    expect(env).toContain("OP_TTS_VOICE=bf_isabella");  // TTS_ prefixed
    expect(env).toContain("OP_ENABLED_ADDONS=discord,slack"); // from legacy stack.yml
    expect(env).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);
    // Secrets NEVER land in the non-secret stack.env.
    expect(env).not.toContain("OP_UI_LOGIN_PASSWORD");
    expect(env).not.toContain("GROQ_API_KEY");
    expect(env).not.toContain("OP_CAP_LLM");
    expect(env).not.toContain("hunter2");

    // Login password extracted; provider + capability keys quarantined to the .bak.
    expect(readFileSync(join(home, "knowledge", "secrets", "op_ui_login_password"), "utf-8").trim()).toBe("hunter2");
    const removed = readFileSync(join(home, "knowledge", "env", "stack.env.removed-secrets.bak"), "utf-8");
    expect(removed).toContain("GROQ_API_KEY=gsk-FAKE");
    expect(removed).toContain("OP_CAP_LLM=openai");

    // Channel secret value preserved through the 0.12 portal rename.
    expect(readFileSync(join(home, "knowledge", "secrets", "portal_discord_secret"), "utf-8").trim()).toBe("disc-abc");
    // Credential dir copied into the new layout (recursive).
    expect(readFileSync(join(home, "knowledge", "secrets", ".gcloud", "credentials.json"), "utf-8")).toContain("fake");

    // vault/ retained with a safe-removal README; originals recoverable from backup.
    expect(existsSync(join(home, "vault", "README.md"))).toBe(true);
    expect(existsSync(join(layout.backupDir!, "vault", "stack", "stack.env"))).toBe(true);
  });

  it("is idempotent — a second upgrade run changes nothing", () => {
    seed010Hellscape();
    runUpgrade("v0.12.0-rc.5");
    const after1 = snapshot();
    delete after1["data/backups/"];

    const second = runUpgrade("v0.12.0-rc.5");
    expect(second.layout.migrated).toBe(false);

    const after2 = snapshot();
    delete after2["data/backups/"];
    expect(after2).toEqual(after1);
  });
});

// ── Scenario 2b: 0.9.x config/ "hellscape" → 0.12.0 (pre-vault, layout 0 → 1 → 2) ─
//
// A deliberately MESSY 0.9.x home: the old config/ env files (with a login
// password + a real-looking provider key that must be quarantined), automations,
// compose "components" (including channel-slack.yml → slack addon), schemas, and
// assorted junk scattered around. After upgrade everything must be organized:
// data extracted into knowledge/, the old 0.9.x files retained under
// config/legacy-0.9/ (never deleted), and user data/logs/backups untouched.
//
// NOTE: every secret below is SYNTHETIC (no real credentials in fixtures).
describe("scenario: 0.9.x config/ hellscape → 0.12.0", () => {
  function seed09Hellscape(): void {
    seed({
      // 0.9.x env files (flat KEY=val under config/)
      "config/system.env": [
        "OP_ADMIN_PORT=8100",          // → renamed OP_HOST_UI_PORT
        "OP_GUARDIAN_PORT=8180",       // → dropped (removed var)
        "OP_UI_LOGIN_PASSWORD=hunter2", // → extracted to knowledge/secrets/ (SYNTHETIC)
        "OPENAI_API_KEY=sk-FAKE-NOT-REAL", // → quarantined to .removed-secrets.bak (SYNTHETIC)
        "TTS_VOICE=bf_isabella",       // → renamed OP_TTS_VOICE
        "OP_KEEP_ME=1",                // → kept verbatim
        "",
      ].join("\n"),
      "config/system.env.schema": "OP_ADMIN_PORT=number\n",
      "config/user.env": "MY_PREF=hello\nMY_SYNTHETIC_TOKEN=abc123-FAKE\n",
      "config/user.env.schema": "MY_PREF=string\n",
      "config/openpalm.yml": "version: 1\naddons: []\n",
      "config/ov.conf": "# old overrides\nfoo=bar\n",
      // 0.9.x compose "components" — channel-slack.yml ⇒ slack addon
      "config/components/core.yml": "services:\n  guardian: {}\n",
      "config/components/admin.yml": "services:\n  admin: {}\n",
      "config/components/channel-slack.yml": "services:\n  slack: {}\n",
      "config/components/junk.txt": "stray file inside components\n",
      // 0.9.x automations → knowledge/tasks/
      "config/automations/digest.yml": "id: digest\ncron: '0 9 * * *'\n",
      "config/automations/.DS_Store": "macos junk\n",
      // user data / service data / logs / old backups — must be UNTOUCHED
      "data/assistant/.keep": "",
      "data/stash/memory.db": "sqlite\n",
      "logs/assistant.log": "boot ok\n",
      "backups/old-0.9-backup.tgz": "tarball\n",
    });
  }

  it("organizes the 0.9.x home into the v2 layout and retains the originals", () => {
    seed09Hellscape();
    const { layout } = runUpgrade("v0.12.0-rc.5");

    // Reached the current layout via the 0 → 1 → 2 chain, backed up first.
    expect(layout.from).toBe(0);
    expect(layout.to).toBe(CURRENT_LAYOUT_VERSION);
    expect(layout.backupDir).toBeTruthy();
    expect(existsSync(layout.backupDir!)).toBe(true);

    // EXACT resulting file set: data extracted to knowledge/, 0.9.x files relocated
    // under config/legacy-0.9/, user data/logs/backups untouched, nothing deleted.
    // Sorted alphabetically: old 0.9 backups (untouched) + relocated 0.9.x
    // originals under config/legacy-0.9/ + extracted knowledge/ layout + untouched
    // data/logs. Nothing deleted.
    expect(fileSet()).toEqual([
      "backups/old-0.9-backup.tgz",                       // old top-level backups — UNTOUCHED
      "config/legacy-0.9/README.md",                      // retained 0.9.x originals (recovery copy)
      "config/legacy-0.9/automations/.DS_Store",
      "config/legacy-0.9/automations/digest.yml",
      "config/legacy-0.9/components/admin.yml",
      "config/legacy-0.9/components/channel-slack.yml",
      "config/legacy-0.9/components/core.yml",
      "config/legacy-0.9/components/junk.txt",
      "config/legacy-0.9/openpalm.yml",
      "config/legacy-0.9/ov.conf",
      "config/legacy-0.9/system.env",
      "config/legacy-0.9/system.env.schema",
      "config/legacy-0.9/user.env",
      "config/legacy-0.9/user.env.schema",
      "data/assistant/.keep",                             // service data — UNTOUCHED
      "data/backups/",
      "data/stash/memory.db",
      "knowledge/env/stack.env",                          // extracted into the new knowledge/ layout
      "knowledge/env/stack.env.removed-secrets.bak",
      "knowledge/env/user.env",
      "knowledge/secrets/op_ui_login_password",
      "knowledge/tasks/.DS_Store",
      "knowledge/tasks/digest.yml",
      "logs/assistant.log",                               // logs — UNTOUCHED
    ]);

    // stack.env transformed correctly.
    const env = readEnv();
    expect(env).toContain("OP_HOST_UI_PORT=8100");      // OP_ADMIN_PORT renamed
    expect(env).not.toContain("OP_GUARDIAN_PORT");      // removed var dropped
    expect(env).toContain("OP_TTS_VOICE=bf_isabella");  // TTS_ prefixed
    expect(env).toContain("OP_KEEP_ME=1");              // unknown key kept
    expect(env).toContain("OP_ENABLED_ADDONS=slack");   // from channel-slack.yml
    expect(env).toContain(`OP_LAYOUT_VERSION=${CURRENT_LAYOUT_VERSION}`);
    // Secrets NEVER land in the non-secret stack.env.
    expect(env).not.toContain("OP_UI_LOGIN_PASSWORD");
    expect(env).not.toContain("OPENAI_API_KEY");
    expect(env).not.toContain("sk-FAKE");
    expect(env).not.toContain("hunter2");

    // Login password extracted to its own secret file (value preserved).
    expect(readFileSync(join(home, "knowledge", "secrets", "op_ui_login_password"), "utf-8").trim()).toBe("hunter2");
    // Provider key quarantined to the .bak (not lost, not in stack.env).
    expect(readFileSync(join(home, "knowledge", "env", "stack.env.removed-secrets.bak"), "utf-8"))
      .toContain("OPENAI_API_KEY=sk-FAKE-NOT-REAL");
    // user.env relocated verbatim.
    expect(readFileSync(join(home, "knowledge", "env", "user.env"), "utf-8")).toContain("MY_PREF=hello");
    // Originals recoverable from the full-home backup.
    expect(existsSync(join(layout.backupDir!, "config", "system.env"))).toBe(true);
  });

  it("is idempotent — a second upgrade run changes nothing", () => {
    seed09Hellscape();
    runUpgrade("v0.12.0-rc.5");
    const after1 = snapshot();
    delete after1["data/backups/"];

    const second = runUpgrade("v0.12.0-rc.5");
    expect(second.layout.migrated).toBe(false);

    const after2 = snapshot();
    delete after2["data/backups/"];
    expect(after2).toEqual(after1);
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

    // config/stack/core.compose.yml is a MANAGED orphan removed by layout v2→v3
    // (self-heals at system/stack on reconcile; recoverable from the backup).
    expect(fileSet()).toEqual([
      "data/.keep",
      "data/backups/",
      "knowledge/env/stack.env",
    ]);
    expect(existsSync(join(report.backupDir!, "config", "stack", "core.compose.yml"))).toBe(true);
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
