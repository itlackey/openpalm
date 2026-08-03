/**
 * Batch-1 groundwork for the `remote` addon (Tailscale tunnel sidecar).
 *
 * This is pure registry plumbing — no compose file, no route, no UI exists
 * yet. These tests pin the pieces those later batches build on: `remote` is a
 * built-in addon id (but not a guardian-ingress or portal-secret one — it has
 * neither), its env schema matches the documented config contract, its
 * TS_AUTHKEY secret is delegated out of the assistant-visible stash, writing
 * any of its three env keys is scoped to recreating "tunnel", and its two
 * home directories are pre-created like every other addon's.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_ADDON_IDS,
  GUARDIAN_INGRESS_ADDON_IDS,
  PORTAL_SECRET_ADDON_IDS,
} from "./addon-ids.js";
import {
  BUILTIN_ADDON_ENV_SCHEMAS,
  ADDON_ENV_RECREATE_SCOPE,
} from "./addon-env-schemas.js";
import { isDelegatedSecretName } from "./secrets-files.js";
import { ensureHomeDirs, remoteServeConfigDir, remoteTunnelStateDir } from "./home.js";
import { listAvailableAddonIds } from "./addons.js";

// Minimal re-implementation of the `.env.schema` parser the credentials route
// (packages/ui/.../addons/[name]/credentials/+server.ts) uses to turn a
// schema string into structured fields. That parser lives in the UI package
// and isn't exported, so it can't be imported from here; this copy tracks the
// same three annotations (`@required`, `@sensitive`, `@boolean`) documented
// in addon-env-schemas.ts's header comment, plus `@required`, which the UI
// parser currently ignores but the config contract for `remote` depends on.
type SchemaField = { key: string; required: boolean; sensitive: boolean; boolean: boolean; default: string };

function parseEnvSchema(text: string): SchemaField[] {
  const fields: SchemaField[] = [];
  let required = false;
  let sensitive = false;
  let bool = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const body = line.slice(1).trim();
      if (body === "---") {
        required = false;
        sensitive = false;
        bool = false;
        continue;
      }
      if (body.startsWith("@")) {
        if (/\B@required\b/.test(body)) required = true;
        if (/\B@sensitive\b/.test(body)) sensitive = true;
        if (/\B@boolean\b/.test(body)) bool = true;
        continue;
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    const def = line.slice(eq + 1).trim();
    fields.push({ key, required, sensitive, boolean: bool, default: def });
    required = false;
    sensitive = false;
    bool = false;
  }
  return fields;
}

describe("remote addon registration", () => {
  it("is a built-in addon id, alphabetically placed", () => {
    expect(BUILTIN_ADDON_IDS).toContain("remote");
    expect([...BUILTIN_ADDON_IDS]).toEqual([...BUILTIN_ADDON_IDS].sort());
  });

  it("has no guardian-served ingress and owns no portal secret", () => {
    // remote's tunnel reaches assistant/guardian as a client of their existing
    // ports; it doesn't add ingress the guardian serves, and it has no
    // portal_<id>_secret of its own (its own secret, TS_AUTHKEY, is a
    // delegated tailnet credential, not a portal principal secret).
    expect(GUARDIAN_INGRESS_ADDON_IDS).not.toContain("remote");
    expect(PORTAL_SECRET_ADDON_IDS).not.toContain("remote");
  });

  it("is discoverable via listAvailableAddonIds()", () => {
    expect(listAvailableAddonIds()).toContain("remote");
  });
});

describe("remote addon env schema", () => {
  const schema = BUILTIN_ADDON_ENV_SCHEMAS.remote;
  const fields = parseEnvSchema(schema ?? "");
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

  it("exists and declares exactly the config-contract keys", () => {
    expect(schema).toBeTruthy();
    expect(Object.keys(byKey).sort()).toEqual(
      ["OP_REMOTE_HOSTNAME", "OP_REMOTE_PUBLIC", "OP_REMOTE_TARGET", "TS_AUTHKEY"].sort(),
    );
  });

  it("defaults OP_REMOTE_TARGET to assistant", () => {
    expect(byKey.OP_REMOTE_TARGET?.default).toBe("assistant");
  });

  it("marks OP_REMOTE_PUBLIC boolean, defaulting to private (false)", () => {
    expect(byKey.OP_REMOTE_PUBLIC?.boolean).toBe(true);
    expect(byKey.OP_REMOTE_PUBLIC?.default).toBe("false");
  });

  it("leaves OP_REMOTE_HOSTNAME blank by default (derives from project name)", () => {
    expect(byKey.OP_REMOTE_HOSTNAME?.default).toBe("");
  });

  it("marks TS_AUTHKEY sensitive but NOT required — blank means interactive login", () => {
    expect(byKey.TS_AUTHKEY?.sensitive).toBe(true);
    expect(byKey.TS_AUTHKEY?.required).toBe(false);
    expect(byKey.TS_AUTHKEY?.default).toBe("");
  });
});

describe("TS_AUTHKEY is a delegated secret", () => {
  it("routes to the private (non-stash) secrets dir, not the assistant-visible one", () => {
    expect(isDelegatedSecretName("ts_authkey")).toBe(true);
  });
});

describe("remote env keys require recreating the tunnel service", () => {
  it("maps all three OP_REMOTE_* keys to [\"tunnel\"]", () => {
    expect(ADDON_ENV_RECREATE_SCOPE.OP_REMOTE_TARGET).toEqual(["tunnel"]);
    expect(ADDON_ENV_RECREATE_SCOPE.OP_REMOTE_PUBLIC).toEqual(["tunnel"]);
    expect(ADDON_ENV_RECREATE_SCOPE.OP_REMOTE_HOSTNAME).toEqual(["tunnel"]);
  });
});

describe("remote addon home directories", () => {
  it("ensureHomeDirs creates the serve-config dir and the tunnel state dir", () => {
    const prev = process.env.OP_HOME;
    const home = mkdtempSync(join(tmpdir(), "op-home-remote-"));
    try {
      process.env.OP_HOME = home;
      ensureHomeDirs();

      expect(remoteServeConfigDir(home)).toBe(join(home, "system", "stack", "remote"));
      expect(remoteTunnelStateDir(home)).toBe(join(home, "data", "tunnel"));
      expect(existsSync(remoteServeConfigDir(home))).toBe(true);
      expect(existsSync(remoteTunnelStateDir(home))).toBe(true);
      expect(statSync(remoteServeConfigDir(home)).isDirectory()).toBe(true);
      expect(statSync(remoteTunnelStateDir(home)).isDirectory()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
