/**
 * Portal verification-secret contract test.
 *
 * Regression guard for the 0.12.0 "Discord portal stopped working after upgrade"
 * class of bug. That secret name lives in TWO independent places:
 *
 *   1. the shipped compose      → portals.compose.yml mounts `portal_<name>_secret`
 *      (`PRINCIPAL_SECRET_FILE` + the service `secrets:` list + the top-level
 *      `secrets:` file declaration the container reads at runtime)
 *   2. the seeder/lookup         → config-persistence.portalSecretName(<name>)
 *      (used by ensurePortalSecret() on install and the guardian secret audit)
 *
 * Each is unit-tested in isolation, but nothing binds them together. If they
 * drift (e.g. the prefix is renamed in compose but not in portalSecretName), a
 * user's portal breaks — Compose can't materialise the secret, so the portal
 * adapter never gets a HMAC secret to authenticate to the guardian with —
 * while every isolated unit test stays green. This test reproduces that coupling
 * so the drift is caught at build time, not in production.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as yamlParse } from "yaml";
import { portalSecretName } from "./config-persistence.js";

// __dirname = packages/lib/src/control-plane/ ; repo root is four levels up.
const REPO_ROOT = join(import.meta.dir, "../../../..");
const PORTALS_COMPOSE = join(REPO_ROOT, "packages/skeleton/system/stack/portals.compose.yml");

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

      it(`declares ${expectedSecret} at the top level, file-backed under state/secrets/ (§G1 — delegated, never assistant-reachable)`, () => {
        const decl = topLevelSecrets[expectedSecret];
        expect(decl, `top-level secrets: must declare ${expectedSecret}`).toBeDefined();
        // The container reads the file the migration/seeder writes — the basename
        // MUST equal the secret name under state/secrets/, not knowledge/secrets/,
        // which is bind-mounted wholesale into the Assistant.
        expect(basename(decl?.file ?? "")).toBe(expectedSecret);
        expect(decl?.file).toContain("/state/secrets/");
      });
    });
  }

  // S.1b: the guardian's co-hosted OpenAI/Anthropic-compatible edge must ship
  // BOTH credentials wired, or it fails closed (S.1a) and is unusable:
  //   - PRINCIPAL_SECRET_FILE → the already-mounted portal_api_secret, so the
  //     edge presents a valid `api` principal to /oc (§0.2.4 near-miss closed).
  //   - OPENAI_COMPAT_API_KEY_FILE → a dedicated op_api_key the user pastes into
  //     OpenAI-compatible clients (kept distinct from the principal secret so the
  //     audit trail is unambiguous).
  describe("guardian OpenAI-compatible edge (S.1b)", () => {
    const guardian = services.guardian;

    it("mounts PRINCIPAL_SECRET_FILE as the already-mounted portal_api_secret", () => {
      expect(secretFromMount(guardian?.environment?.PRINCIPAL_SECRET_FILE)).toBe("portal_api_secret");
    });

    it("presents the 'api' principal id the portal_api_secret seeds", () => {
      expect(guardian?.environment?.PRINCIPAL_ID).toBe("api");
    });

    it("mounts OPENAI_COMPAT_API_KEY_FILE as a dedicated op_api_key secret", () => {
      expect(secretFromMount(guardian?.environment?.OPENAI_COMPAT_API_KEY_FILE)).toBe("op_api_key");
    });

    it("lists op_api_key in the guardian service secrets:", () => {
      expect(guardian?.secrets ?? []).toContain("op_api_key");
    });

    it("declares op_api_key at the top level, file-backed under state/secrets/ (§G1 — delegated)", () => {
      const decl = topLevelSecrets.op_api_key;
      expect(decl, "top-level secrets: must declare op_api_key").toBeDefined();
      expect(basename(decl?.file ?? "")).toBe("op_api_key");
      expect(decl?.file).toContain("/state/secrets/");
    });
  });

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
