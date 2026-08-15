/**
 * remote-apply.ts: the Node-side apply logic for the `remote` addon.
 *
 * Every home here is a real mkdtemp directory (not a mock fs) — the property
 * under test in most of these cases is what actually lands on disk (an
 * atomic rename, a never-deleted file, a pinned env value), which a mocked
 * fs would just assert back at itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRemoteAccess,
  pinRemoteHostname,
  readRemoteAccessState,
  reconcileRemoteAccess,
  writeServeConfig,
} from "./remote-apply.ts";
import { listEnabledAddonIds } from "./addons.ts";
import { guardianRequired } from "./guardian-required.ts";
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
    expect(doc.AllowFunnel["${TS_CERT_DOMAIN}:443"]).toBe(true);
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
    // guardian's "8443" is gone, not merged in; "3820" is the workspace port
    // that rides along with the assistant.
    expect(Object.keys(doc.TCP)).toEqual(["443", "3820"]);

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

  test("invalid persisted target closes a stale public policy before returning an error", () => {
    const home = makeHome();
    patchStateEnvFile(home, {
      OP_ENABLED_ADDONS: "remote",
      OP_REMOTE_TARGET: "assistant",
      OP_REMOTE_PUBLIC: "true",
    });
    expect(reconcileRemoteAccess(home).error).toBeUndefined();
    expect(
      (readServeDoc(home) as { AllowFunnel: Record<string, boolean> })
        .AllowFunnel["${TS_CERT_DOMAIN}:443"],
    ).toBe(true);

    patchStateEnvFile(home, { OP_REMOTE_TARGET: "nonsense" });
    const result = reconcileRemoteAccess(home);

    expect(result.wrote).toBe(false);
    expect(result.error).toContain("Invalid OP_REMOTE_TARGET");
    expect(readServeDoc(home)).toEqual({ TCP: {}, Web: {}, AllowFunnel: {} });
  });

  test("reports when the fail-closed policy cannot be written", () => {
    const home = makeHome();
    patchStateEnvFile(home, { OP_REMOTE_TARGET: "nonsense" });
    writeFileSync(remoteServeConfigDir(home), "not a directory");

    const result = reconcileRemoteAccess(home);

    expect(result.wrote).toBe(false);
    expect(result.error).toContain("Invalid OP_REMOTE_TARGET");
    expect(result.error).toContain("failed to write fail-closed serve config");
  });
});

// ── applyRemoteAccess ────────────────────────────────────────────────────

describe("applyRemoteAccess", () => {
  test("targeting the guardian turns GUARDIAN_DIRECT_INGRESS on and recreates guardian", () => {
    const home = makeHome();
    patchStateEnvFile(home, {
      OP_ENABLED_ADDONS: "remote,gateway",
      OP_REMOTE_TARGET: "guardian",
      GUARDIAN_DIRECT_INGRESS: "false",
    });

    const result = applyRemoteAccess(home);

    expect(result.error).toBeUndefined();
    expect(result.ingressChanged).toBe(true);
    expect(readStackEnv(home).GUARDIAN_DIRECT_INGRESS).toBe("true");
    // tunnel alone is not enough: GUARDIAN_DIRECT_INGRESS is read by the
    // guardian's own listener at start, so it has to be recreated too or the
    // freshly generated proxy points at a 404.
    expect(result.services).toContain("tunnel");
    expect(result.services).toContain("guardian");
  });

  test("does NOT open the guardian's LAN bind when flipping ingress", () => {
    const home = makeHome();
    patchStateEnvFile(home, {
      OP_ENABLED_ADDONS: "remote,gateway",
      OP_REMOTE_TARGET: "both",
      GUARDIAN_DIRECT_INGRESS: "false",
      OP_GUARDIAN_BIND_ADDRESS: "127.0.0.1",
    });

    applyRemoteAccess(home);

    // The whole point of the remote ingress path: it reaches the guardian
    // over portal_net, so the LAN bind must stay loopback. applyRemoteAccess
    // writes GUARDIAN_DIRECT_INGRESS and nothing else in the access env —
    // turning on remote access can never widen LAN exposure.
    expect(readStackEnv(home).OP_GUARDIAN_BIND_ADDRESS).toBe("127.0.0.1");
  });

  test("targeting the assistant leaves ingress alone and recreates only tunnel", () => {
    const home = makeHome();
    patchStateEnvFile(home, {
      OP_ENABLED_ADDONS: "remote",
      OP_REMOTE_TARGET: "assistant",
      GUARDIAN_DIRECT_INGRESS: "false",
    });

    const result = applyRemoteAccess(home);

    expect(result.ingressChanged).toBe(false);
    expect(result.services).toEqual(["tunnel"]);
    expect(readStackEnv(home).GUARDIAN_DIRECT_INGRESS).toBe("false");
  });

  test("disabling remote turns ingress back off when nothing else needs it", () => {
    const home = makeHome();
    patchStateEnvFile(home, {
      OP_ENABLED_ADDONS: "remote,gateway",
      OP_REMOTE_TARGET: "guardian",
      GUARDIAN_DIRECT_INGRESS: "false",
    });
    applyRemoteAccess(home);
    expect(readStackEnv(home).GUARDIAN_DIRECT_INGRESS).toBe("true");

    // Addon off — the only reason ingress was on is gone. The guardian is
    // still REQUIRED here (gateway), so it stays in the recreate list to pick
    // the flipped GUARDIAN_DIRECT_INGRESS up.
    patchStateEnvFile(home, { OP_ENABLED_ADDONS: "gateway" });
    const result = applyRemoteAccess(home);

    expect(result.ingressChanged).toBe(true);
    expect(readStackEnv(home).GUARDIAN_DIRECT_INGRESS).toBe("false");
    expect(result.services).toEqual(["guardian"]);
  });

  test("removing the guardian's LAST reason keeps it OUT of the recreate list — reconcile stops it instead", () => {
    const home = makeHome();
    patchStateEnvFile(home, {
      OP_ENABLED_ADDONS: "remote",
      OP_REMOTE_TARGET: "guardian",
      GUARDIAN_DIRECT_INGRESS: "false",
    });
    applyRemoteAccess(home);
    expect(readStackEnv(home).GUARDIAN_DIRECT_INGRESS).toBe("true");

    // Target moves off the guardian with no other reason left: its profile
    // just went inactive, so `up guardian` would either error or restart a
    // service that should be stopping. Callers run
    // reconcileGuardianDeployment after this apply, which stops it.
    patchStateEnvFile(home, { OP_REMOTE_TARGET: "assistant" });
    const targetMoved = applyRemoteAccess(home);
    expect(targetMoved.ingressChanged).toBe(true);
    expect(readStackEnv(home).GUARDIAN_DIRECT_INGRESS).toBe("false");
    expect(targetMoved.services).toEqual(["tunnel"]);

    // Same for the disable edge when remote was the sole reason.
    patchStateEnvFile(home, {
      OP_ENABLED_ADDONS: "remote",
      OP_REMOTE_TARGET: "guardian",
    });
    applyRemoteAccess(home);
    expect(readStackEnv(home).GUARDIAN_DIRECT_INGRESS).toBe("true");
    patchStateEnvFile(home, { OP_ENABLED_ADDONS: "" });
    const disabled = applyRemoteAccess(home);
    expect(disabled.ingressChanged).toBe(true);
    expect(disabled.services).toEqual([]);
  });

  test("keeps ingress on when guardianNetwork wants it, even with remote off", () => {
    const home = makeHome();
    // guardianNetwork on: the LAN bind is the OTHER reason ingress is true,
    // and disabling remote must not switch it off underneath that.
    patchStateEnvFile(home, {
      OP_ENABLED_ADDONS: "gateway",
      OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0",
      GUARDIAN_DIRECT_INGRESS: "true",
    });

    const result = applyRemoteAccess(home);

    expect(result.ingressChanged).toBe(false);
    expect(readStackEnv(home).GUARDIAN_DIRECT_INGRESS).toBe("true");
  });

  test("a guardian target with no ingress addon needs no warning — the remote reason itself activates the guardian profile", () => {
    const home = makeHome();
    // remote targets the guardian and no guardian-ingress addon is on. That
    // combination used to warn ("no guardian service is deployed"); now the
    // remote-tunnels-to-guardian condition is a guardianRequired reason
    // (guardian-required.ts), so the bare `guardian` compose profile is
    // active and the guardian in this apply's `services` actually deploys.
    patchStateEnvFile(home, {
      OP_ENABLED_ADDONS: "remote",
      OP_REMOTE_TARGET: "guardian",
    });

    const result = applyRemoteAccess(home);

    expect(result.error).toBeUndefined();
    expect(guardianRequired(home)).toBe(true);
    expect(result.services).toEqual(expect.arrayContaining(["tunnel", "guardian"]));
  });

  test("still writes the disabled serve document when the addon is off", () => {
    const home = makeHome();
    patchStateEnvFile(home, { OP_ENABLED_ADDONS: "" });

    const result = applyRemoteAccess(home);

    expect(result.wrote).toBe(false);
    // The absent ingress setting is written, but with NOTHING requiring the
    // guardian its profile is inactive — no recreate is scheduled for it
    // (callers reconcile a stray running guardian separately).
    expect(readStackEnv(home).GUARDIAN_DIRECT_INGRESS).toBe("false");
    expect(result.services).toEqual([]);
    // Fail-closed: "off" is an explicit empty document, never a missing file.
    expect(readServeDoc(home)).toEqual({ TCP: {}, Web: {}, AllowFunnel: {} });
  });
});

// The local `enabledAddonIds` helper in remote-apply.ts exists only to keep
// addons.ts -> remote-apply.ts a one-way import (see its docblock). It must
// stay observationally identical to the real `listEnabledAddonIds`, so pin
// them against each other on the cases that could plausibly diverge.
describe("enabled-addon read agrees with addons.ts", () => {
  for (const [label, value] of [
    ["single", "remote"],
    ["multiple", "gateway,remote"],
    ["padded", " remote , gateway "],
    ["empty", ""],
    ["unknown ids", "remote,not-a-real-addon"],
    ["duplicates", "remote,remote,gateway"],
  ] as const) {
    test(`${label}: readRemoteAccessState matches listEnabledAddonIds`, () => {
      const home = makeHome();
      patchStateEnvFile(home, { OP_ENABLED_ADDONS: value });

      expect(readRemoteAccessState(home).enabled).toBe(
        listEnabledAddonIds(home).includes("remote"),
      );
    });
  }
});

// Sanity: the stack.env helper used by these tests points at the file the
// module under test actually reads/writes, so a passing suite here means
// something about the real file layout, not an isolated fixture path.
test("stackEnvFile() is inside the home this suite creates", () => {
  const home = makeHome();
  expect(stackEnvFile(home).startsWith(home)).toBe(true);
});
