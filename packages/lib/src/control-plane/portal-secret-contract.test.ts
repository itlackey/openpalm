/**
 * Portal verification-secret contract test.
 *
 * Regression guard for the 0.12.0 "Discord portal stopped working after upgrade"
 * class of bug. That secret name lives in THREE independent places:
 *
 *   1. the shipped compose      → portals.compose.yml mounts `portal_<name>_secret`
 *      (`PRINCIPAL_SECRET_FILE` + the service `secrets:` list + the top-level
 *      `secrets:` file declaration the container reads at runtime)
 *   2. the seeder/lookup         → config-persistence.portalSecretName(<name>)
 *      (used by ensurePortalSecret() on install and the guardian secret audit)
 *   3. the upgrade migration     → migratePortalSecretNames renames the legacy
 *      `channel_<name>_secret` → the NEW name on every pre-0.12 home
 *
 * Each is unit-tested in isolation, but nothing binds them together. If any two
 * drift (e.g. the prefix is renamed in compose but not in the migration target),
 * a freshly-UPGRADED user's portal breaks — Compose can't materialise the secret,
 * or the guardian rejects the portal's HMAC auth (GUARDIAN_REQUIRE_PORTAL_SECRETS
 * is true) — while every isolated unit test stays green. This test reproduces that
 * coupling so the drift is caught at build time, not in production.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse as yamlParse } from "yaml";
import { portalSecretName } from "./config-persistence.js";
import { ensureReleaseMigrated } from "./migrations.js";

// __dirname = packages/lib/src/control-plane/ ; repo root is four levels up.
const REPO_ROOT = join(import.meta.dir, "../../../..");
const PORTALS_COMPOSE = join(REPO_ROOT, ".openpalm/config/stack/portals.compose.yml");

type ComposeService = {
  environment?: Record<string, string>;
  secrets?: string[];
};
type ComposeDoc = {
  services?: Record<string, ComposeService>;
  secrets?: Record<string, { file?: string }>;
};

const compose = yamlParse(readFileSync(PORTALS_COMPOSE, "utf8")) as ComposeDoc;
const services = compose.services ?? {};
const topLevelSecrets = compose.secrets ?? {};

/** Pull the bare `/run/secrets/NAME` basename out of a compose env default like
 *  `${DISCORD_PRINCIPAL_SECRET_FILE:-/run/secrets/portal_discord_secret}`. */
function secretFromMount(value: string | undefined): string | null {
  if (!value) return null;
  const m = value.match(/\/run\/secrets\/([a-z0-9_]+)/i);
  return m ? m[1] : null;
}

// The portal ADAPTER services — the ones identified by a PORTAL_PACKAGE env.
// These are exactly the services that authenticate to the guardian with a
// per-portal verification secret, i.e. what broke for Discord.
const portalAdapters = Object.entries(services).filter(
  ([, svc]) => typeof svc.environment?.PORTAL_PACKAGE === "string",
);

describe("portal verification-secret contract (compose ↔ portalSecretName ↔ migration)", () => {
  it("ships at least the discord + slack portal adapters", () => {
    const names = portalAdapters.map(([n]) => n).sort();
    expect(names).toContain("discord");
    expect(names).toContain("slack");
  });

  for (const [name, svc] of portalAdapters) {
    describe(`portal: ${name}`, () => {
      const expectedSecret = portalSecretName(name);

      it(`mounts PRINCIPAL_SECRET_FILE as portalSecretName('${name}') = ${expectedSecret}`, () => {
        const mounted = secretFromMount(svc.environment?.PRINCIPAL_SECRET_FILE);
        expect(mounted).toBe(expectedSecret);
      });

      it(`lists ${expectedSecret} in its service-level secrets:`, () => {
        expect(svc.secrets ?? []).toContain(expectedSecret);
      });

      it(`declares ${expectedSecret} at the top level, file-backed under knowledge/secrets/`, () => {
        const decl = topLevelSecrets[expectedSecret];
        expect(decl, `top-level secrets: must declare ${expectedSecret}`).toBeDefined();
        // The container reads the file the migration/seeder writes — the basename
        // MUST equal the secret name, under knowledge/secrets/.
        expect(basename(decl!.file ?? "")).toBe(expectedSecret);
        expect(decl!.file).toContain("/knowledge/secrets/");
      });
    });
  }

  it("every secret a service references is declared at the top level (else Compose fails to start)", () => {
    const declared = new Set(Object.keys(topLevelSecrets));
    const missing: string[] = [];
    for (const [name, svc] of Object.entries(services)) {
      for (const ref of svc.secrets ?? []) {
        if (!declared.has(ref)) missing.push(`${name} → ${ref}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ── The upgrade path: the migration must produce the EXACT names compose mounts ──

describe("upgrade migration produces the secret names portals.compose.yml mounts", () => {
  let home: string;
  let prevOpHome: string | undefined;

  beforeEach(() => {
    prevOpHome = process.env.OP_HOME;
    home = mkdtempSync(join(tmpdir(), "op-portal-secret-"));
    process.env.OP_HOME = home;
    mkdirSync(join(home, "knowledge", "env"), { recursive: true });
    mkdirSync(join(home, "knowledge", "secrets"), { recursive: true });
    // A pre-0.12 home: stamped below the rename migration so it is selected.
    writeFileSync(
      join(home, "knowledge", "env", "stack.env"),
      "OP_IMAGE_TAG=v0.12.0\nOP_RELEASE_VERSION=v0.11.5\n",
    );
  });

  afterEach(() => {
    if (prevOpHome === undefined) delete process.env.OP_HOME;
    else process.env.OP_HOME = prevOpHome;
    rmSync(home, { recursive: true, force: true });
  });

  for (const [name] of portalAdapters) {
    it(`renames legacy channel_${name}_secret → the mounted portal name`, () => {
      const expectedSecret = portalSecretName(name);
      const legacy = join(home, "knowledge", "secrets", `channel_${name}_secret`);
      writeFileSync(legacy, "legacy-value\n");

      const report = ensureReleaseMigrated({ targetVersion: "v0.12.0-rc.1" });
      expect(report.migrated).toBe(true);

      // The file the upgraded container will mount must now exist with the
      // value preserved, and the legacy name must be gone.
      const produced = join(home, "knowledge", "secrets", expectedSecret);
      expect(existsSync(produced)).toBe(true);
      expect(readFileSync(produced, "utf-8").trim()).toBe("legacy-value");
      expect(existsSync(legacy)).toBe(false);
    });
  }
});
