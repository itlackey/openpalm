/**
 * remote-apply.ts: the Node-side apply logic for the `remote` addon.
 *
 * Every home here is a real mkdtemp directory (not a mock fs) — the property
 * under test in most of these cases is what actually lands on disk (an
 * atomic rename, a never-deleted file, a pinned env value), which a mocked
 * fs would just assert back at itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pinRemoteHostname,
  readRemoteAccessState,
  reconcileRemoteAccess,
  writeServeConfig,
} from "./remote-apply.ts";
import {
  REMOTE_ACCESS_DEFAULTS,
  deriveRemoteHostname,
  resolveServeConfig,
  type RemoteAccessConfig,
} from "./remote-access.ts";
import { remoteServeConfigDir, stackEnvFile } from "./home.ts";
import { patchStateEnvFile, readStackEnv } from "./secrets.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "op-remote-apply-"));
  tmpDirs.push(home);
  return home;
}

function servePath(home: string): string {
  return join(remoteServeConfigDir(home), "serve.json");
}

function readServeDoc(home: string): unknown {
  return JSON.parse(readFileSync(servePath(home), "utf-8"));
}

// ── writeServeConfig ─────────────────────────────────────────────────────

describe("writeServeConfig", () => {
  for (const target of ["assistant", "guardian", "both"] as const) {
    test(`writes the resolveServeConfig() document for target=${target}`, () => {
      const home = makeHome();
      const cfg: RemoteAccessConfig = { hostname: "openpalm", public: false, target };

      writeServeConfig(home, cfg);

      const raw = readFileSync(servePath(home), "utf-8");
      // Pretty-printed JSON with a trailing newline, per the spec — not just
      // "parses to the right value".
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw).toBe(`${JSON.stringify(resolveServeConfig(cfg), null, 2)}\n`);
      expect(JSON.parse(raw)).toEqual(resolveServeConfig(cfg));
    });
  }

  test("public:true writes an explicit AllowFunnel:true, not an omitted key", () => {
    const home = makeHome();
    writeServeConfig(home, { hostname: "openpalm", public: true, target: "assistant" });
    const doc = readServeDoc(home) as { AllowFunnel: Record<string, boolean> };
    expect(Object.values(doc.AllowFunnel)).toEqual([true]);
  });

  test("a rewrite fully replaces the document atomically — no merge, no leftover temp file", () => {
    const home = makeHome();
    writeServeConfig(home, { hostname: "openpalm", public: true, target: "guardian" });
    expect(readServeDoc(home)).toEqual(resolveServeConfig({
      hostname: "openpalm",
      public: true,
      target: "guardian",
    }));

    // A different config entirely — if the write were a merge instead of an
    // atomic replace, guardian's port/handler would still be present here.
    const next: RemoteAccessConfig = { hostname: "openpalm", public: false, target: "assistant" };
    writeServeConfig(home, next);

    const doc = readServeDoc(home) as { TCP: Record<string, unknown> };
    expect(doc).toEqual(resolveServeConfig(next));
    expect(Object.keys(doc.TCP)).toEqual(["443"]); // guardian's "8443" is gone, not merged in

    // The temp file the atomic writer used must never linger — a leftover
    // `.tmp` is the signature of a write that was never actually renamed in.
    expect(existsSync(`${servePath(home)}.tmp`)).toBe(false);
  });

  test("the parent directory is created on demand (fresh home, no ensureHomeDirs)", () => {
    const home = makeHome();
    expect(existsSync(remoteServeConfigDir(home))).toBe(false);

    writeServeConfig(home, REMOTE_ACCESS_DEFAULTS);

    expect(existsSync(servePath(home))).toBe(true);
  });
});

// ── reconcileRemoteAccess: disabling never deletes serve.json ────────────

describe("disabling never deletes serve.json", () => {
  test("a disabled addon leaves the file present with AllowFunnel empty (nothing funneled)", () => {
    const home = makeHome();

    // Start from a config that WAS publicly funneling something, as if the
    // addon had been on before.
    writeServeConfig(home, { hostname: "openpalm", public: true, target: "assistant" });
    expect(existsSync(servePath(home))).toBe(true);

    // OP_ENABLED_ADDONS deliberately does not include "remote".
    const result = reconcileRemoteAccess(home);

    expect(result.enabled).toBe(false);
    expect(result.wrote).toBe(false);
    // Never absent — deleting would leave a previously-funneled service
    // exposed indefinitely, per readServeConfig's "missing file = no change".
    expect(existsSync(servePath(home))).toBe(true);

    const doc = readServeDoc(home) as {
      TCP: Record<string, unknown>;
      Web: Record<string, unknown>;
      AllowFunnel: Record<string, boolean>;
    };
    expect(doc.TCP).toEqual({});
    expect(doc.Web).toEqual({});
    expect(doc.AllowFunnel).toEqual({});
    // No key evaluates truthy — funneling is off, not just "not mentioned".
    expect(Object.values(doc.AllowFunnel).some(Boolean)).toBe(false);
  });
});

// ── pinRemoteHostname ─────────────────────────────────────────────────────

describe("pinRemoteHostname", () => {
  test("derives from OP_PROJECT_NAME and persists it on first call", () => {
    const home = makeHome();
    patchStateEnvFile(home, { OP_PROJECT_NAME: "My Stack!" });

    const hostname = pinRemoteHostname(home);

    expect(hostname).toBe(deriveRemoteHostname("My Stack!"));
    expect(readStackEnv(home).OP_REMOTE_HOSTNAME).toBe(hostname);
  });

  test("an explicit projectName override is used over stack.env's OP_PROJECT_NAME", () => {
    const home = makeHome();
    patchStateEnvFile(home, { OP_PROJECT_NAME: "from-env" });

    const hostname = pinRemoteHostname(home, "from-override");

    expect(hostname).toBe(deriveRemoteHostname("from-override"));
  });

  test("falls back to 'openpalm' with no project name anywhere", () => {
    const home = makeHome();
    expect(pinRemoteHostname(home)).toBe("openpalm");
  });

  test("REGRESSION (project rename): a second call keeps the original pin, never re-derives", () => {
    const home = makeHome();
    patchStateEnvFile(home, { OP_PROJECT_NAME: "alpha" });

    const first = pinRemoteHostname(home);
    expect(first).toBe(deriveRemoteHostname("alpha"));

    // Simulate a later `docker compose` project rename — exactly the
    // scenario recordProjectRename/teardownRenamedProject handle for the
    // running containers, but must NOT be allowed to move this hostname.
    patchStateEnvFile(home, { OP_PROJECT_NAME: "beta" });

    const second = pinRemoteHostname(home);

    // Must still be the FIRST call's value, not deriveRemoteHostname("beta") —
    // moving here would silently break the operator's public URL, bookmarks,
    // and any QR code made from it.
    expect(second).toBe(first);
    expect(second).not.toBe(deriveRemoteHostname("beta"));
    expect(readStackEnv(home).OP_REMOTE_HOSTNAME).toBe(first);
  });
});

// ── readRemoteAccessState ─────────────────────────────────────────────────

describe("readRemoteAccessState", () => {
  test("reports disabled and default config on a fresh home", () => {
    const home = makeHome();
    // hostname resolves to the "openpalm" fallback (no OP_PROJECT_NAME set),
    // not REMOTE_ACCESS_DEFAULTS.hostname's literal "" — that field means
    // "derive", and readRemoteAccessConfig always resolves the derivation.
    expect(readRemoteAccessState(home)).toEqual({
      enabled: false,
      config: { ...REMOTE_ACCESS_DEFAULTS, hostname: "openpalm" },
    });
  });

  test("reports enabled once 'remote' is in OP_ENABLED_ADDONS", () => {
    const home = makeHome();
    patchStateEnvFile(home, { OP_ENABLED_ADDONS: "remote" });
    expect(readRemoteAccessState(home).enabled).toBe(true);
  });
});

// ── reconcileRemoteAccess: end-to-end ──────────────────────────────────────

describe("reconcileRemoteAccess", () => {
  test("enabled: pins the hostname, writes the live document, wrote:true", () => {
    const home = makeHome();
    patchStateEnvFile(home, {
      OP_ENABLED_ADDONS: "remote",
      OP_PROJECT_NAME: "foo",
      OP_REMOTE_TARGET: "guardian",
      OP_REMOTE_PUBLIC: "true",
    });

    const result = reconcileRemoteAccess(home);

    expect(result.enabled).toBe(true);
    expect(result.wrote).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.hostname).toBe(deriveRemoteHostname("foo"));
    expect(result.config).toEqual({ hostname: result.hostname, public: true, target: "guardian" });

    // Persisted, not just returned.
    expect(readStackEnv(home).OP_REMOTE_HOSTNAME).toBe(result.hostname);
    expect(readServeDoc(home)).toEqual(resolveServeConfig(result.config));
  });

  test("disabled: writes the empty document, pins nothing, wrote:false", () => {
    const home = makeHome();
    // No OP_ENABLED_ADDONS at all — addon is off.
    patchStateEnvFile(home, { OP_PROJECT_NAME: "bar" });

    const result = reconcileRemoteAccess(home);

    expect(result.enabled).toBe(false);
    expect(result.wrote).toBe(false);
    expect(result.error).toBeUndefined();
    expect(existsSync(servePath(home))).toBe(true);
    expect(readServeDoc(home)).toEqual({ TCP: {}, Web: {}, AllowFunnel: {} });
    // Disabling must not burn the one-time hostname pin.
    expect(readStackEnv(home).OP_REMOTE_HOSTNAME).toBeUndefined();
  });

  test("a second enabled reconcile after a rename keeps the pinned hostname", () => {
    const home = makeHome();
    patchStateEnvFile(home, { OP_ENABLED_ADDONS: "remote", OP_PROJECT_NAME: "alpha" });

    const first = reconcileRemoteAccess(home);
    patchStateEnvFile(home, { OP_PROJECT_NAME: "beta" });
    const second = reconcileRemoteAccess(home);

    expect(second.hostname).toBe(first.hostname);
    expect(second.hostname).not.toBe(deriveRemoteHostname("beta"));
  });
});

// Sanity: the stack.env helper used by these tests points at the file the
// module under test actually reads/writes, so a passing suite here means
// something about the real file layout, not an isolated fixture path.
test("stackEnvFile() is inside the home this suite creates", () => {
  const home = makeHome();
  expect(stackEnvFile(home).startsWith(home)).toBe(true);
});
