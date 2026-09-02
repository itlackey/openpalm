/**
 * The schema gate exists so a legacy migration stops running once it has run.
 * These call the real functions against a real temp home and check the file
 * contents that result — the point is observable behavior, not that a symbol
 * is mentioned somewhere.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  HOME_SCHEMA_VERSION,
  ensureHomeDirs,
  homeSchemaVersionFile,
  legacyKnowledgeStackEnvFile,
  legacyStateEnvFile,
  readHomeSchemaVersion,
  stackEnvFile,
  writeHomeSchemaVersion,
} from './home.js';
import { runHomeMigrations } from './home-schema.js';

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-schema-'));
});
afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

/** A home as it looked before the port correction: assistant 3800 / UI 3810. */
function seedLegacyHome(): void {
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
  writeFileSync(legacyKnowledgeStackEnvFile(homeDir), 'OP_ASSISTANT_PORT=3800\nOP_UI_PORT=3810\n');
}

describe('a fresh home runs no legacy migrations', () => {
  test('ensureHomeDirs stamps a brand-new home as current', async () => {
    ensureHomeDirs(homeDir);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('runHomeMigrations does not touch stack.env on a fresh home', async () => {
    ensureHomeDirs(homeDir);
    writeFileSync(legacyKnowledgeStackEnvFile(homeDir), 'OP_ASSISTANT_PORT=3810\nOP_UI_PORT=3800\n');
    const before = readFileSync(legacyKnowledgeStackEnvFile(homeDir), 'utf-8');

    expect(await runHomeMigrations(homeDir)).toBe(false);
    expect(readFileSync(legacyKnowledgeStackEnvFile(homeDir), 'utf-8')).toBe(before);
  });
});

describe('an absent install is left alone', () => {
  test('a home with no stack env in any location is not migrated and not stamped', async () => {
    // Read-only commands migrate before reading state, so this runs against
    // machines that have no install at all. It must not materialize state/.
    expect(await runHomeMigrations(homeDir)).toBe(false);
    expect(existsSync(homeSchemaVersionFile(homeDir))).toBe(false);
    expect(existsSync(stackEnvFile(homeDir))).toBe(false);
  });
});

describe('an existing home migrates exactly once', () => {
  test('an unstamped legacy home is migrated, then recorded as current', async () => {
    seedLegacyHome();
    // No stamp: ensureHomeDirs would have declined to write one because
    // stack.env already existed.
    ensureHomeDirs(homeDir);
    expect(existsSync(homeSchemaVersionFile(homeDir))).toBe(false);

    expect(await runHomeMigrations(homeDir)).toBe(true);

    // The port fix landed, and the file it landed in is the consolidated one.
    const migrated = readFileSync(stackEnvFile(homeDir), 'utf-8');
    expect(migrated).toContain('OP_ASSISTANT_PORT=3810');
    expect(migrated).toContain('OP_UI_PORT=3800');
    expect(existsSync(legacyKnowledgeStackEnvFile(homeDir))).toBe(false);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('a second run is a no-op and leaves the file byte-identical', async () => {
    seedLegacyHome();
    ensureHomeDirs(homeDir);
    await runHomeMigrations(homeDir);
    const afterFirst = readFileSync(stackEnvFile(homeDir), 'utf-8');

    expect(await runHomeMigrations(homeDir)).toBe(false);
    expect(readFileSync(stackEnvFile(homeDir), 'utf-8')).toBe(afterFirst);
  });

  // issue #643: a rollback can restore state/schema-version alongside a
  // pre-rollback stack.env, so an operator's post-rollback hand edit to the
  // CONSOLIDATED state/stack.env sits there while schema-version reads 0 and
  // knowledge/env/stack.env (never deleted by the failed update) still
  // carries no ports. The next runHomeMigrations re-runs the whole chain from
  // since:0 — migrateLegacyDefaultPorts must carry the explicit consolidated
  // value into the legacy file rather than writing the corrected default, or
  // migrateToSingleStackEnv's target-only-key merge won't see it as already
  // defined and the fresh default silently wins.
  test("an operator's explicit consolidated ports survive a schema-version reset to 0", async () => {
    seedLegacyHome();
    // Overwrite the legacy seed: neither port is set there at all (the shape
    // that makes migrateLegacyDefaultPorts materialize corrected defaults).
    writeFileSync(legacyKnowledgeStackEnvFile(homeDir), 'OP_PROJECT_NAME=verify643\nOP_ENABLED_ADDONS=\n');
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(
      stackEnvFile(homeDir),
      'OP_PROJECT_NAME=verify643\nOP_ASSISTANT_PORT=3812\nOP_UI_PORT=3802\n',
    );
    writeHomeSchemaVersion(homeDir, 0);

    expect(await runHomeMigrations(homeDir)).toBe(true);

    const migrated = readFileSync(stackEnvFile(homeDir), 'utf-8');
    expect(migrated).toContain('OP_ASSISTANT_PORT=3812');
    expect(migrated).toContain('OP_UI_PORT=3802');
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('schema 5 migrates the persisted Paperclip signing key', async () => {
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    mkdirSync(join(homeDir, 'state', 'env'), { recursive: true });
    writeFileSync(stackEnvFile(homeDir), 'OP_ENABLED_ADDONS=paperclip\n');
    writeFileSync(
      join(homeDir, 'state', 'env', 'paperclip.env'),
      'BETTER_AUTH_SECRET=auth\nPAPERCLIP_TOOL_ACTION_SIGNING_SECRET=legacy\n',
    );
    writeHomeSchemaVersion(homeDir, 5);

    expect(await runHomeMigrations(homeDir)).toBe(true);
    expect(readFileSync(join(homeDir, 'state', 'env', 'paperclip.env'), 'utf8')).toBe(
      'BETTER_AUTH_SECRET=auth\nPAPERCLIP_AGENT_JWT_SECRET=legacy\n',
    );
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('the two stack env files are merged into one, and the originals removed', async () => {
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(legacyKnowledgeStackEnvFile(homeDir), '# operator notes\nOP_OWNER_NAME=alice\nOP_UI_PORT=3800\n');
    writeFileSync(legacyStateEnvFile(homeDir), 'OP_UI_PORT=9999\nOP_ENABLED_ADDONS=slack\n');
    writeHomeSchemaVersion(homeDir, 1);

    expect(await runHomeMigrations(homeDir)).toBe(true);

    const merged = readFileSync(stackEnvFile(homeDir), 'utf-8');
    expect(merged).toContain('OP_OWNER_NAME=alice');
    expect(merged).toContain('OP_ENABLED_ADDONS=slack');
    expect(merged).toContain('# operator notes'); // operator comments survive
    expect(merged).toContain('OP_UI_PORT=9999'); // state won, as Compose applied it
    expect(merged).not.toContain('OP_UI_PORT=3800');

    expect(existsSync(legacyKnowledgeStackEnvFile(homeDir))).toBe(false);
    expect(existsSync(legacyStateEnvFile(homeDir))).toBe(false);
  });

  test('a version in the knowledge file is dropped, because it recorded the last applied release rather than a pin', async () => {
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(
      legacyKnowledgeStackEnvFile(homeDir),
      'OP_ASSISTANT_VERSION=0.12.33\nOP_GUARDIAN_VERSION=0.12.33\n',
    );
    writeFileSync(legacyStateEnvFile(homeDir), 'OP_GUARDIAN_VERSION=0.13.0\n');
    writeHomeSchemaVersion(homeDir, 1);

    await runHomeMigrations(homeDir);

    const merged = readFileSync(stackEnvFile(homeDir), 'utf-8');
    // Promoting this would have frozen the install at its current image.
    expect(merged).not.toContain('OP_ASSISTANT_VERSION=0.12.33');
    // A real pin, recorded in the app-owned file, survives.
    expect(merged).toContain('OP_GUARDIAN_VERSION=0.13.0');
  });

  test('a bootstrap stub at the target never overrides the operator real state', async () => {
    // ensureSystemSecrets writes state/stack.env with OP_SETUP_COMPLETE=false
    // whenever the file is absent — which, on a pre-consolidation home, is
    // every time. If that stub wins the merge, a fully-installed operator is
    // told setup never completed and gets sent back to the wizard.
    mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(legacyKnowledgeStackEnvFile(homeDir), 'OP_OWNER_NAME=alice\n');
    writeFileSync(legacyStateEnvFile(homeDir), 'OP_SETUP_COMPLETE=true\nOP_ENABLED_ADDONS=slack\n');
    writeFileSync(stackEnvFile(homeDir), '# OpenPalm — Stack Configuration\nOP_SETUP_COMPLETE=false\nOP_ONLY_IN_STUB=keep\n');
    writeHomeSchemaVersion(homeDir, 1);

    await runHomeMigrations(homeDir);

    const merged = readFileSync(stackEnvFile(homeDir), 'utf-8');
    expect(merged).toContain('OP_SETUP_COMPLETE=true');
    expect(merged).not.toContain('OP_SETUP_COMPLETE=false');
    expect(merged).toContain('OP_ENABLED_ADDONS=slack');
    expect(merged).toContain('OP_OWNER_NAME=alice');
    // A key only the stub defined is still carried over — nothing is lost.
    expect(merged).toContain('OP_ONLY_IN_STUB=keep');
  });

  test('an unreadable version record is treated as pre-record, not as current', async () => {
    seedLegacyHome();
    ensureHomeDirs(homeDir);
    writeFileSync(homeSchemaVersionFile(homeDir), 'not-a-number\n');

    expect(readHomeSchemaVersion(homeDir)).toBe(0);
    expect(await runHomeMigrations(homeDir)).toBe(true);
  });
});

describe("retired skeleton files are removed from an upgraded home", () => {
  test("deletes the moved opencode.jsonc pair and the three retired tasks, and nothing else", async () => {
    // Seeding outside system/ is add-only, so a file a release DELETED stays
    // on every upgraded home. Both orphan sets were confirmed present on a
    // real install: the .jsonc pair is live-read USER config (the assistant's
    // still pins akm-opencode@latest), and the retired tasks are listed by the
    // Automations tab as real automations akm will never run.
    const home = mkdtempSync(join(tmpdir(), "op-retired-"));
    try {
      const write = (rel: string, body = "x\n") => {
        mkdirSync(dirname(join(home, rel)), { recursive: true });
        writeFileSync(join(home, rel), body);
      };
      for (const rel of [
        "config/assistant/opencode.jsonc",
        "config/guardian/opencode.jsonc",
        "knowledge/tasks/health-check.yml",
        "knowledge/tasks/update-containers.yml",
        "knowledge/tasks/validate-config.yml",
      ]) write(rel);
      // Live files the current skeleton still ships — must survive untouched.
      write("config/assistant/opencode.json", '{"keep":true}\n');
      write("knowledge/tasks/akm-improve.yml", "version: 2\n");

      // Migrations correctly no-op on a home with no stack env (an absent
      // install, not an unmigrated one), so give it one.
      mkdirSync(join(home, "state"), { recursive: true });
      writeFileSync(join(home, "state", "stack.env"), "OP_SETUP_COMPLETE=true\n");
      await runHomeMigrations(home);

      expect(existsSync(join(home, "config/assistant/opencode.jsonc"))).toBe(false);
      expect(existsSync(join(home, "config/guardian/opencode.jsonc"))).toBe(false);
      expect(existsSync(join(home, "knowledge/tasks/update-containers.yml"))).toBe(false);
      expect(existsSync(join(home, "knowledge/tasks/health-check.yml"))).toBe(false);
      expect(existsSync(join(home, "knowledge/tasks/validate-config.yml"))).toBe(false);
      // Untouched.
      expect(readFileSync(join(home, "config/assistant/opencode.json"), "utf-8")).toContain("keep");
      expect(existsSync(join(home, "knowledge/tasks/akm-improve.yml"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reports the files it actually deleted, not the candidate list", async () => {
    // This migration deletes without any modification check — unlike the skills
    // sweep, it never asks whether the operator edited the file first. Its log
    // line is therefore the ONLY record that something of theirs is gone, so it
    // has to name what it removed. It used to log the static five-path array on
    // every run, which told a operator who had customised
    // config/assistant/opencode.jsonc nothing about whether theirs was among
    // the four it skipped.
    const home = mkdtempSync(join(tmpdir(), "op-retired-log-"));
    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      // Exactly ONE of the five retired paths is present.
      mkdirSync(join(home, "knowledge/tasks"), { recursive: true });
      writeFileSync(join(home, "knowledge/tasks/health-check.yml"), "x\n");
      mkdirSync(join(home, "state"), { recursive: true });
      writeFileSync(join(home, "state", "stack.env"), "OP_SETUP_COMPLETE=true\n");

      await runHomeMigrations(home);

      const line = warnings.find((w) => w.includes("Removed retired skeleton files"));
      expect(line, "migration did not log a removal line").toBeTruthy();
      const serialized = String(line);
      expect(serialized).toContain("health-check.yml");
      // The four that were never there must NOT be claimed as removed.
      for (const absent of [
        "config/assistant/opencode.jsonc",
        "config/guardian/opencode.jsonc",
        "update-containers.yml",
        "validate-config.yml",
      ]) {
        expect(serialized).not.toContain(absent);
      }
    } finally {
      console.error = originalError;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('v7 → v8: the removed chat addon', () => {
  /** A stamped v7 home whose stack.env is exactly `content`. */
  function seedV7Home(content: string): void {
    mkdirSync(dirname(stackEnvFile(homeDir)), { recursive: true });
    writeFileSync(stackEnvFile(homeDir), content);
    writeHomeSchemaVersion(homeDir, 7);
  }
  const env = () => readFileSync(stackEnvFile(homeDir), 'utf-8');

  test('chat as the only guardian reason: substituted with api, exposure untouched', async () => {
    seedV7Home('OP_ENABLED_ADDONS=chat\nOP_SETUP_COMPLETE=true\nOP_GUARDIAN_BIND_ADDRESS=127.0.0.1\n');

    expect(await runHomeMigrations(homeDir)).toBe(true);

    // The guardian (and its loopback OpenAI-compatible edge) keeps deploying —
    // via the api addon, which is visible and removable, with the install's
    // exact current exposure. NOTHING may open a bind or the direct listener:
    // any install whose door was actually open reads as guardianRequired on
    // its own, so a toggle substitution could only ever fire on CLOSED
    // installs (hard invariant 4).
    expect(env()).toMatch(/^OP_ENABLED_ADDONS=api$/m);
    expect(env()).not.toMatch(/^OP_ACCESS_GUARDIAN=true$/m);
    expect(env()).not.toMatch(/GUARDIAN_DIRECT_INGRESS=true/);
    expect(env()).toMatch(/^OP_GUARDIAN_BIND_ADDRESS=127\.0\.0\.1$/m);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('chat with the guardianNetwork toggle explicitly OFF: the opt-out is honored, api still substituted', async () => {
    // The population main\'s auto-enable created: guardianNetwork turned on
    // (auto-enabling chat), later turned off — nothing ever disabled chat.
    seedV7Home('OP_ENABLED_ADDONS=chat\nOP_ACCESS_GUARDIAN=false\nOP_GUARDIAN_BIND_ADDRESS=127.0.0.1\nGUARDIAN_DIRECT_INGRESS=false\n');

    expect(await runHomeMigrations(homeDir)).toBe(true);

    expect(env()).toMatch(/^OP_ENABLED_ADDONS=api$/m);
    expect(env()).toMatch(/^OP_ACCESS_GUARDIAN=false$/m);
    expect(env()).toMatch(/^OP_GUARDIAN_BIND_ADDRESS=127\.0\.0\.1$/m);
    expect(env()).toMatch(/^GUARDIAN_DIRECT_INGRESS=false$/m);
  });

  test('chat beside another ingress addon: dropped with NO substitution and NO exposure change', async () => {
    seedV7Home('OP_ENABLED_ADDONS=chat,discord\nOP_GUARDIAN_BIND_ADDRESS=127.0.0.1\n');

    expect(await runHomeMigrations(homeDir)).toBe(true);

    expect(env()).toMatch(/^OP_ENABLED_ADDONS=discord$/m);
    expect(env()).not.toMatch(/^OP_ACCESS_GUARDIAN=true$/m);
    expect(env()).toMatch(/^OP_GUARDIAN_BIND_ADDRESS=127\.0\.0\.1$/m);
  });

  test('chat with guardianNetwork already on: dropped, the toggle is reason enough', async () => {
    seedV7Home(
      'OP_ENABLED_ADDONS=chat\nOP_ACCESS_GUARDIAN=true\nOP_GUARDIAN_BIND_ADDRESS=0.0.0.0\nGUARDIAN_DIRECT_INGRESS=true\n',
    );

    expect(await runHomeMigrations(homeDir)).toBe(true);

    expect(env()).not.toMatch(/\bchat\b/);
    expect(env()).toMatch(/^OP_ENABLED_ADDONS=$/m);
    expect(env()).toMatch(/^OP_ACCESS_GUARDIAN=true$/m);
  });

  test('chat with a remote tunnel targeting the guardian: dropped, remote is reason enough', async () => {
    seedV7Home('OP_ENABLED_ADDONS=chat,remote\nOP_REMOTE_TARGET=guardian\n');

    expect(await runHomeMigrations(homeDir)).toBe(true);

    expect(env()).toMatch(/^OP_ENABLED_ADDONS=remote$/m);
    expect(env()).not.toMatch(/^OP_ACCESS_GUARDIAN=true$/m);
  });

  test('a v7 home without chat is a no-op that still stamps v8', async () => {
    seedV7Home('OP_ENABLED_ADDONS=discord\n');
    const before = env();

    expect(await runHomeMigrations(homeDir)).toBe(false);

    expect(env()).toBe(before);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });
});

// ── schema 9 → 10: private/ folds into state/, retired skeleton trees go ──────

describe('schema 9 → 10: the OP_HOME layout change', () => {
  /** A v9 home with the retired trees populated. */
  function seedV9Home(): void {
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(stackEnvFile(homeDir), 'OP_SETUP_COMPLETE=true\n');
    mkdirSync(join(homeDir, 'private', 'secrets'), { recursive: true });
    mkdirSync(join(homeDir, 'private', 'env'), { recursive: true });
    writeFileSync(join(homeDir, 'private', 'secrets', 'op_ui_login_password'), 'hunter2\n');
    writeFileSync(join(homeDir, 'private', 'secrets', 'ts_authkey'), 'tskey-abc\n');
    writeFileSync(join(homeDir, 'private', 'env', 'paperclip.env'), 'BETTER_AUTH_SECRET=a\n');
    writeHomeSchemaVersion(homeDir, 9);
  }

  test('credentials move to state/, and the emptied private/ tree is removed', async () => {
    seedV9Home();

    expect(await runHomeMigrations(homeDir)).toBe(true);

    expect(readFileSync(join(homeDir, 'state', 'secrets', 'op_ui_login_password'), 'utf8')).toBe('hunter2\n');
    expect(readFileSync(join(homeDir, 'state', 'secrets', 'ts_authkey'), 'utf8')).toBe('tskey-abc\n');
    expect(readFileSync(join(homeDir, 'state', 'env', 'paperclip.env'), 'utf8')).toBe('BETTER_AUTH_SECRET=a\n');
    expect(existsSync(join(homeDir, 'private'))).toBe(false);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('a name present in BOTH locations with different content leaves both alone', async () => {
    seedV9Home();
    mkdirSync(join(homeDir, 'state', 'secrets'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'secrets', 'ts_authkey'), 'tskey-different\n');

    await runHomeMigrations(homeDir);

    // Neither version of a credential is discarded to resolve a conflict.
    expect(readFileSync(join(homeDir, 'private', 'secrets', 'ts_authkey'), 'utf8')).toBe('tskey-abc\n');
    expect(readFileSync(join(homeDir, 'state', 'secrets', 'ts_authkey'), 'utf8')).toBe('tskey-different\n');
    // The unambiguous ones still moved, and private/ survives holding only the conflict.
    expect(existsSync(join(homeDir, 'state', 'secrets', 'op_ui_login_password'))).toBe(true);
    expect(existsSync(join(homeDir, 'private', 'secrets', 'op_ui_login_password'))).toBe(false);
  });

  test('identical content in both locations completes the interrupted move', async () => {
    seedV9Home();
    mkdirSync(join(homeDir, 'state', 'secrets'), { recursive: true });
    writeFileSync(join(homeDir, 'state', 'secrets', 'ts_authkey'), 'tskey-abc\n');

    await runHomeMigrations(homeDir);

    expect(existsSync(join(homeDir, 'private'))).toBe(false);
    expect(readFileSync(join(homeDir, 'state', 'secrets', 'ts_authkey'), 'utf8')).toBe('tskey-abc\n');
  });

  test('the always-empty knowledge/paperclip overlay dirs are removed', async () => {
    seedV9Home();
    mkdirSync(join(homeDir, 'knowledge', 'paperclip', 'env'), { recursive: true });
    mkdirSync(join(homeDir, 'knowledge', 'paperclip', 'secrets'), { recursive: true });

    await runHomeMigrations(homeDir);

    expect(existsSync(join(homeDir, 'knowledge', 'paperclip'))).toBe(false);
  });

  test('an operator file under the retired overlay keeps its directory', async () => {
    seedV9Home();
    mkdirSync(join(homeDir, 'knowledge', 'paperclip', 'secrets'), { recursive: true });
    writeFileSync(join(homeDir, 'knowledge', 'paperclip', 'secrets', 'mine.txt'), 'keep\n');

    await runHomeMigrations(homeDir);

    expect(readFileSync(join(homeDir, 'knowledge', 'paperclip', 'secrets', 'mine.txt'), 'utf8')).toBe('keep\n');
  });

  // The stash-skill dedup is NOT a migration: it needs the shipped tree to
  // compare against, so it runs from applyHomeSeed (see ui-assets.test.ts).

  test('a home with none of the retired trees reports no change but is still stamped current', async () => {
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(stackEnvFile(homeDir), 'OP_SETUP_COMPLETE=true\n');
    writeHomeSchemaVersion(homeDir, 9);

    expect(await runHomeMigrations(homeDir)).toBe(false);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });
});

// ── schema 10 → 11: the retired tasks the `since: 6` sweep can never reach ────

describe('schema 10 → 11: the versionless retired task files', () => {
  /**
   * A home stamped 10 — every home upgraded during 0.13.0 development — still
   * carrying the files the `since: 6` sweep would have taken, because
   * `migration.since >= recorded` never lets that entry run here.
   */
  function seedV10Home(): void {
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(stackEnvFile(homeDir), 'OP_SETUP_COMPLETE=true\n');
    mkdirSync(join(homeDir, 'knowledge', 'tasks'), { recursive: true });
    for (const name of ['health-check.yml', 'update-containers.yml', 'validate-config.yml']) {
      // Byte-for-byte the shape the retired skeleton shipped: NO `version:` key,
      // which is exactly what akm 0.9.7 refuses to parse.
      writeFileSync(
        join(homeDir, 'knowledge', 'tasks', name),
        "schedule: '0 3 * * *'\nenabled: false\ntimeoutMs: 10000\ncommand:\n  - sh\n  - -c\n  - openpalm status\n",
      );
    }
    mkdirSync(join(homeDir, 'config', 'assistant'), { recursive: true });
    writeFileSync(join(homeDir, 'config', 'assistant', 'opencode.jsonc'), '{"plugin":[]}\n');
    writeHomeSchemaVersion(homeDir, 10);
  }

  const tasks = () => readdirSync(join(homeDir, 'knowledge', 'tasks')).sort();

  test('the three versionless files go, and the home is stamped current', async () => {
    seedV10Home();
    // A shipped task that akm still accepts must survive.
    writeFileSync(join(homeDir, 'knowledge', 'tasks', 'akm-improve.yml'), 'version: 4\nname: improve\n');

    expect(await runHomeMigrations(homeDir)).toBe(true);

    expect(tasks()).toEqual(['akm-improve.yml']);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('the opencode.jsonc pair is deliberately NOT re-swept on a home stamped 10', async () => {
    // Only the task files break anything (they take down akm's whole scheduler
    // sync). These two are stale, not broken, and they live in the tree the
    // operator owns and edits — so this entry does not blind-delete there.
    seedV10Home();

    await runHomeMigrations(homeDir);

    expect(readFileSync(join(homeDir, 'config', 'assistant', 'opencode.jsonc'), 'utf8')).toBe(
      '{"plugin":[]}\n',
    );
  });

  test("an operator's own task file is untouched", async () => {
    seedV10Home();
    writeFileSync(join(homeDir, 'knowledge', 'tasks', 'wiki-ingestion.yml'), 'version: 2\nname: wiki\n');

    await runHomeMigrations(homeDir);

    expect(readFileSync(join(homeDir, 'knowledge', 'tasks', 'wiki-ingestion.yml'), 'utf8')).toBe(
      'version: 2\nname: wiki\n',
    );
    expect(tasks()).toEqual(['wiki-ingestion.yml']);
  });

  test("an operator's own task AT one of the three retired names is deleted too", async () => {
    // Pinning the collision, not endorsing it: the sweep matches on filename
    // with no modification check, so a task the operator wrote at one of these
    // three names goes with the retired seed. Nothing on disk distinguishes
    // the two, and a versionless file left behind can never be scheduled at
    // all — so this is the deliberate trade, and the upgrade guide warns about
    // it for beta homes as well as 0.12.x ones.
    seedV10Home();
    writeFileSync(join(homeDir, 'knowledge', 'tasks', 'health-check.yml'), 'version: 2\nname: mine\n');

    await runHomeMigrations(homeDir);

    expect(tasks()).toEqual([]);
  });

  test('re-running removes nothing and reports no change', async () => {
    seedV10Home();
    writeFileSync(join(homeDir, 'knowledge', 'tasks', 'wiki-ingestion.yml'), 'version: 2\nname: wiki\n');
    await runHomeMigrations(homeDir);
    const afterFirst = tasks();

    // The gate stops the second call outright.
    expect(await runHomeMigrations(homeDir)).toBe(false);
    // And the sweep itself is a no-op when re-armed against an already-clean home.
    writeHomeSchemaVersion(homeDir, 10);
    expect(await runHomeMigrations(homeDir)).toBe(false);
    expect(tasks()).toEqual(afterFirst);
  });
});

// ── schema → 12: the three akm config heals move into MIGRATIONS (#654) ──────
//
// Each used to run UNVERSIONED on every apply forever (lifecycle.ts's
// `applyHomeAssets`). Stamping the home at 11 (one below HOME_SCHEMA_VERSION)
// means ONLY these `since: 11` entries fire — every earlier migration's
// `since` is below 11, so `since < recorded` skips it — which is what makes
// each test below fail if its migration is ever removed from the registry,
// not merely if the underlying akm-sources.ts function is deleted.

function akmConfigPath(home: string): string {
  return join(home, 'config', 'akm', 'config.json');
}

function seedAkmHome(config: Record<string, unknown>): void {
  mkdirSync(join(homeDir, 'config', 'akm'), { recursive: true });
  // Trailing newline matters: stripRetiredAkmConfigKeys compares serialized
  // BYTES (its writer always appends one), so a "no change expected" seed
  // written without one would spuriously "change" on the newline alone.
  writeFileSync(akmConfigPath(homeDir), `${JSON.stringify(config, null, 2)}\n`);
  mkdirSync(join(homeDir, 'state'), { recursive: true });
  writeFileSync(stackEnvFile(homeDir), 'OP_SETUP_COMPLETE=true\n');
  writeHomeSchemaVersion(homeDir, 11);
}

function readAkmConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(akmConfigPath(home), 'utf-8'));
}

describe('schema → 12: stripRetiredAkmConfigKeys is a migration', () => {
  test('translates a 0.12.x profiles.llm profile into engines instead of dropping it (#645)', async () => {
    seedAkmHome({
      profiles: {
        llm: { default: { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', provider: 'openai' } },
      },
      defaults: { llm: 'default' },
      bundles: { openpalm: { path: '/stash', writable: true } },
      defaultBundle: 'openpalm',
    });

    expect(await runHomeMigrations(homeDir)).toBe(true);

    const cfg = readAkmConfig(homeDir);
    expect(cfg.profiles).toBeUndefined();
    expect(cfg.engines).toEqual({
      default: { kind: 'llm', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', provider: 'openai' },
    });
    expect((cfg.defaults as Record<string, unknown>).llmEngine).toBe('default');
    expect(cfg.configVersion).toBe('0.9.0');
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('also sweeps config/paperclip/akm/config.json', async () => {
    seedAkmHome({ configVersion: '0.9.0', bundles: { openpalm: { path: '/stash', writable: true } } });
    mkdirSync(join(homeDir, 'config', 'paperclip', 'akm'), { recursive: true });
    const pcPath = join(homeDir, 'config', 'paperclip', 'akm', 'config.json');
    writeFileSync(pcPath, JSON.stringify({ stashDir: '/stash', profiles: { agent: {} } }, null, 2));

    await runHomeMigrations(homeDir);

    const pc = JSON.parse(readFileSync(pcPath, 'utf-8'));
    expect(pc.stashDir).toBeUndefined();
    expect(pc.profiles).toBeUndefined();
    expect(pc.configVersion).toBe('0.9.0');
  });

  test('a config with nothing retired reports no change', async () => {
    // Also already clean for the two migrations that share this file
    // (reconcileDuplicateBundles, ensureSystemBundle) — otherwise their
    // changes would make `runHomeMigrations` return true for a reason other
    // than the one this test is pinning.
    seedAkmHome({
      configVersion: '0.9.0',
      bundles: {
        openpalm: { path: '/stash', writable: true },
        'openpalm-system': { path: '/system-stash', writable: false, enabled: true },
      },
      defaultBundle: 'openpalm',
    });
    expect(await runHomeMigrations(homeDir)).toBe(false);
  });
});

describe('schema → 12: reconcileDuplicateBundles is a migration', () => {
  test('collapses two bundle ids pointing at the same directory and moves the default with them', async () => {
    seedAkmHome({
      bundles: {
        openpalm: { path: '/stash', writable: true },
        stash: { path: '/stash', writable: true },
      },
      defaultBundle: 'stash',
    });

    expect(await runHomeMigrations(homeDir)).toBe(true);

    const cfg = readAkmConfig(homeDir);
    // `stash` is gone (deduped into `openpalm`); `openpalm-system` is also
    // present — ensureSystemBundle runs in the same pass (both are `since: 11`
    // migrations on this home) and this config had no system bundle either.
    expect(Object.keys(cfg.bundles as Record<string, unknown>).sort()).toEqual(['openpalm', 'openpalm-system']);
    expect(cfg.defaultBundle).toBe('openpalm');
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('no duplicate — no change', async () => {
    // Also already clean for the two neighbouring migrations that share this
    // file (stripRetiredAkmConfigKeys, ensureSystemBundle).
    seedAkmHome({
      configVersion: '0.9.0',
      bundles: {
        openpalm: { path: '/stash', writable: true },
        'host-akm': { path: '/host-stash', writable: true },
        'openpalm-system': { path: '/system-stash', writable: false, enabled: true },
      },
      defaultBundle: 'openpalm',
    });
    expect(await runHomeMigrations(homeDir)).toBe(false);
  });
});

describe('schema → 12: ensureSystemBundle is a migration', () => {
  test('registers the /system-stash bundle a config written before the skills move never got', async () => {
    seedAkmHome({
      configVersion: '0.9.0',
      bundles: { openpalm: { path: '/stash', writable: true, enabled: true } },
      defaultBundle: 'openpalm',
    });

    expect(await runHomeMigrations(homeDir)).toBe(true);

    const cfg = readAkmConfig(homeDir);
    expect((cfg.bundles as Record<string, unknown>)['openpalm-system']).toEqual({
      path: '/system-stash',
      writable: false,
      enabled: true,
    });
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });

  test('already present — no change', async () => {
    seedAkmHome({
      configVersion: '0.9.0',
      bundles: {
        openpalm: { path: '/stash', writable: true },
        'openpalm-system': { path: '/system-stash', writable: false, enabled: true },
      },
      defaultBundle: 'openpalm',
    });
    expect(await runHomeMigrations(homeDir)).toBe(false);
  });
});

// ── #657.3: replay safety — a rolled-back operator edit must survive ─────────

describe('replay safety: operator edits survive a schema-version reset to 0', () => {
  test('explicit ports, a hand-set addon toggle, and an operator-edited engine all survive replaying the whole chain', async () => {
    // A legacy-shaped home: a translatable 0.12.x akm profile, a duplicate
    // bundle id, and a config missing the system bundle — everything the three
    // moved akm migrations heal, all at once, on a home nothing has ever
    // stamped (recorded 0 — the worst case, where every migration fires).
    mkdirSync(join(homeDir, 'config', 'akm'), { recursive: true });
    writeFileSync(
      akmConfigPath(homeDir),
      JSON.stringify(
        {
          profiles: {
            llm: { default: { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', provider: 'openai' } },
          },
          defaults: { llm: 'default' },
          bundles: {
            openpalm: { path: '/stash', writable: true },
            stash: { path: '/stash', writable: true },
          },
          defaultBundle: 'stash',
        },
        null,
        2,
      ),
    );
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    writeFileSync(stackEnvFile(homeDir), 'OP_SETUP_COMPLETE=true\nOP_ENABLED_ADDONS=discord\n');

    // First pass: the whole chain runs once.
    expect(await runHomeMigrations(homeDir)).toBe(true);
    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
    const afterFirstRun = readAkmConfig(homeDir);
    expect(afterFirstRun.profiles).toBeUndefined();
    expect((afterFirstRun.engines as Record<string, Record<string, unknown>>).default.model).toBe('gpt-4o-mini');

    // Operator edits, made AFTER the migration ran and BEFORE any rollback:
    //  1. Explicit ports, by hand, in the consolidated file.
    //  2. A hand-set addon toggle (already there — confirm it survives too).
    //  3. The operator tweaks the just-translated engine's model.
    const stackEnvBefore = readFileSync(stackEnvFile(homeDir), 'utf-8');
    writeFileSync(
      stackEnvFile(homeDir),
      `${stackEnvBefore}OP_ASSISTANT_PORT=3812\nOP_UI_PORT=3802\n`,
    );
    const editedCfg = { ...afterFirstRun, engines: { default: { ...(afterFirstRun.engines as Record<string, Record<string, unknown>>).default, model: 'gpt-4o' } } };
    writeFileSync(akmConfigPath(homeDir), JSON.stringify(editedCfg, null, 2));

    // Simulate a rollback: the restored files carry the operator's edits, but
    // state/schema-version reverts to 0 (issue #657 part 3 — rollback restores
    // the OLDER schema-version alongside the files, because the restored files
    // ARE the older shape; a failed-then-recovered attempt then replays the
    // whole chain against files an operator has since hand-edited).
    writeHomeSchemaVersion(homeDir, 0);

    expect(await runHomeMigrations(homeDir)).toBe(true);

    // Ports: untouched. migrateConsolidatedDefaultPorts only ever swaps the
    // EXACT retired pair (3800/3810); 3812/3802 is neither, so it never probes
    // or moves them.
    const stackEnvAfter = readFileSync(stackEnvFile(homeDir), 'utf-8');
    expect(stackEnvAfter).toContain('OP_ASSISTANT_PORT=3812');
    expect(stackEnvAfter).toContain('OP_UI_PORT=3802');
    // The hand-set addon toggle: untouched.
    expect(stackEnvAfter).toMatch(/^OP_ENABLED_ADDONS=discord$/m);

    // The akm config: `profiles` is already gone, so translateLegacyLlmProfiles
    // has nothing left to translate — replay is a no-op there, and the
    // operator's own post-translation edit survives byte-for-byte.
    const finalCfg = readAkmConfig(homeDir);
    expect(finalCfg.profiles).toBeUndefined();
    expect((finalCfg.engines as Record<string, Record<string, unknown>>).default.model).toBe('gpt-4o');
    // The dedup and system-bundle heals are also no-ops the second time:
    // there is no duplicate left, and the system bundle is already there.
    expect(Object.keys(finalCfg.bundles as Record<string, unknown>).sort()).toEqual(['openpalm', 'openpalm-system']);

    expect(readHomeSchemaVersion(homeDir)).toBe(HOME_SCHEMA_VERSION);
  });
});
