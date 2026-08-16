/**
 * Pins for the remote-access provider registry (remote-providers.ts) and the
 * machinery it leans on — the contracts remote-access-providers.md §3/§8
 * names as load-bearing:
 *
 *  - registry ↔ compose agreement: the Tailscale entry's profile, services,
 *    and secrets match what services.compose.yml actually declares, so the
 *    two cannot drift silently;
 *  - the generalized profile grammar accepts provider variants while the
 *    hardware-only reader still rejects them;
 *  - the default-provider fallback keeps a bare `OP_ENABLED_ADDONS=remote`
 *    deploying the tunnel after the profile rename — and a stored selection
 *    alone never implies enablement;
 *  - computeGuardianIngressRequired is the one ingress answer, agreeing
 *    with the pre-registry predicate it consolidated.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as yamlParse } from "yaml";
import { readFileSync } from "node:fs";
import {
  REMOTE_PROVIDERS,
  DEFAULT_REMOTE_PROFILE,
  DEFAULT_REMOTE_PROVIDER_ID,
  selectedRemoteProviderId,
  remoteAddonEnabled,
  computeGuardianIngressRequired,
  describeSelectedRemoteExposure,
  resolveWorkspaceAdvertisement,
} from "./remote-providers.js";
import { parseWorkspaceOrigin } from "./workspace-origin.js";
import {
  canonicalAddonProfileSelection,
  resolveHardwareProfileVariant,
} from "./profile-ids.js";
import { remoteRequiresGuardianIngress } from "./access-toggles.js";
import { resolveActiveProfiles } from "./compose-args.js";
import type { ControlPlaneState } from "./types.js";

const REPO_ROOT = join(import.meta.dir, "../../../..");

type ComposeDoc = {
  services?: Record<string, { profiles?: string[] }>;
  secrets?: Record<string, unknown>;
};

function loadServicesCompose(): ComposeDoc {
  const path = join(REPO_ROOT, "packages/skeleton/system/stack/services.compose.yml");
  return yamlParse(readFileSync(path, "utf-8")) as ComposeDoc;
}

// ── Registry ↔ compose agreement ─────────────────────────────────────────

describe("registry ↔ services.compose.yml agreement", () => {
  const compose = loadServicesCompose();
  const tailscale = REMOTE_PROVIDERS.tailscale;

  test("every declared service exists and is gated behind exactly the provider's profile", () => {
    for (const service of tailscale.services) {
      const svc = compose.services?.[service];
      expect(svc).toBeDefined();
      expect(svc?.profiles).toEqual([tailscale.profile]);
    }
  });

  test("every declared secret is a top-level compose secret (Compose fails container creation on a missing declared file — the seeding sweep exists for these)", () => {
    for (const secretName of tailscale.secrets) {
      expect(compose.secrets ?? {}).toHaveProperty(secretName);
    }
  });

  test("the default provider's profile is the fallback resolveActiveProfiles uses", () => {
    expect(REMOTE_PROVIDERS[DEFAULT_REMOTE_PROVIDER_ID].profile).toBe(DEFAULT_REMOTE_PROFILE);
  });
});

// ── Profile grammar: provider variants admitted, hardware reader unchanged ─

describe("generalized profile grammar (profile-ids.ts)", () => {
  test("provider-variant ids are canonical selections for their addon", () => {
    expect(canonicalAddonProfileSelection("remote", "addon.remote.tailscale")).toBe(
      "addon.remote.tailscale",
    );
    // The grammar admits future provider suffixes without another widening.
    expect(canonicalAddonProfileSelection("remote", "addon.remote.pangolin-proxy")).toBe(
      "addon.remote.pangolin-proxy",
    );
  });

  test("a provider profile for a DIFFERENT addon is rejected", () => {
    expect(canonicalAddonProfileSelection("voice", "addon.remote.tailscale")).toBe("");
  });

  test("hardware-variant resolution still admits only cpu|cuda|rocm", () => {
    expect(resolveHardwareProfileVariant("addon.voice.cuda")).toBe("cuda");
    expect(resolveHardwareProfileVariant("addon.remote.tailscale")).toBeNull();
  });
});

// ── Selection ────────────────────────────────────────────────────────────

describe("selectedRemoteProviderId", () => {
  test("defaults to tailscale for absent, blank, and unrecognized selections", () => {
    expect(selectedRemoteProviderId({})).toBe("tailscale");
    expect(selectedRemoteProviderId({ OP_REMOTE_PROFILE: "" })).toBe("tailscale");
    expect(selectedRemoteProviderId({ OP_REMOTE_PROFILE: "addon.remote.nonsense" })).toBe(
      "tailscale",
    );
    expect(selectedRemoteProviderId({ OP_REMOTE_PROFILE: "garbage" })).toBe("tailscale");
  });

  test("resolves a stored provider profile to its provider", () => {
    expect(selectedRemoteProviderId({ OP_REMOTE_PROFILE: "addon.remote.tailscale" })).toBe(
      "tailscale",
    );
  });
});

// ── The one ingress writer ───────────────────────────────────────────────

describe("computeGuardianIngressRequired", () => {
  test("false while the addon is disabled, whatever the config says", () => {
    expect(
      computeGuardianIngressRequired({ OP_REMOTE_TARGET: "guardian" }),
    ).toBe(false);
  });

  test("tracks the selected provider's target once enabled", () => {
    expect(
      computeGuardianIngressRequired({
        OP_ENABLED_ADDONS: "remote",
        OP_REMOTE_TARGET: "assistant",
      }),
    ).toBe(false);
    expect(
      computeGuardianIngressRequired({
        OP_ENABLED_ADDONS: "remote",
        OP_REMOTE_TARGET: "guardian",
      }),
    ).toBe(true);
    expect(
      computeGuardianIngressRequired({
        OP_ENABLED_ADDONS: "remote",
        OP_REMOTE_TARGET: "both",
      }),
    ).toBe(true);
  });

  test("agrees with the pre-registry predicate it consolidated (anti-drift pin)", () => {
    for (const target of ["assistant", "guardian", "both"] as const) {
      for (const enabled of [true, false]) {
        const env = {
          OP_ENABLED_ADDONS: enabled ? "gateway,remote" : "gateway",
          OP_REMOTE_TARGET: target,
        };
        expect(computeGuardianIngressRequired(env)).toBe(
          remoteRequiresGuardianIngress(enabled, target),
        );
      }
    }
  });
});

describe("describeSelectedRemoteExposure", () => {
  test("an addon that is off opens nothing", () => {
    expect(
      describeSelectedRemoteExposure({ OP_REMOTE_TARGET: "both", OP_REMOTE_PUBLIC: "true" }),
    ).toEqual([]);
  });

  test("reports ports, never URLs, once enabled", () => {
    const lines = describeSelectedRemoteExposure({
      OP_ENABLED_ADDONS: "remote",
      OP_REMOTE_TARGET: "assistant",
    });
    // Two doors: exposing the assistant also publishes OpenCode's workspace.
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("port 443");
    for (const line of lines) expect(line).not.toContain("https://");
  });

  test("a relocated workspace port is disclosed at the number actually published", () => {
    const lines = describeSelectedRemoteExposure({
      OP_ENABLED_ADDONS: "remote",
      OP_REMOTE_TARGET: "assistant",
      OP_WORKSPACE_PORT: "4820",
    });
    expect(lines.some((line) => line.includes("port 4820"))).toBe(true);
  });
});

// ── The bare-enable fallback (compose-args.ts) ───────────────────────────

describe("resolveActiveProfiles — remote provider fallback", () => {
  let tempDir: string;

  function makeState(): ControlPlaneState {
    return {
      homeDir: tempDir,
      configDir: join(tempDir, "config"),
      stashDir: join(tempDir, "knowledge"),
      workspaceDir: join(tempDir, "workspace"),
      dataDir: join(tempDir, "data"),
      stackDir: join(tempDir, "system", "stack"),
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
    };
  }

  function seedStackEnv(content: string): void {
    const stateDir = join(tempDir, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "stack.env"), content);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "remote-providers-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("a bare enabled remote activates the DEFAULT provider profile, not the retired bare profile", () => {
    seedStackEnv("OP_ENABLED_ADDONS=remote\n");
    const profiles = resolveActiveProfiles(makeState());
    expect(profiles).toContain(DEFAULT_REMOTE_PROFILE);
    expect(profiles).not.toContain("addon.remote");
  });

  test("a stored selection wins over the fallback", () => {
    seedStackEnv("OP_ENABLED_ADDONS=remote\nOP_REMOTE_PROFILE=addon.remote.tailscale\n");
    expect(resolveActiveProfiles(makeState())).toContain("addon.remote.tailscale");
  });

  test("a stored selection alone NEVER implies enablement — deliberately unlike the legacy voice/ollama profile-only activation", () => {
    seedStackEnv("OP_REMOTE_PROFILE=addon.remote.tailscale\n");
    const profiles = resolveActiveProfiles(makeState());
    expect(profiles.some((p) => p.startsWith("addon.remote"))).toBe(false);
  });
});

// ── remoteAddonEnabled matches the env-list semantics callers rely on ────

describe("remoteAddonEnabled", () => {
  test("reads OP_ENABLED_ADDONS membership", () => {
    expect(remoteAddonEnabled({})).toBe(false);
    expect(remoteAddonEnabled({ OP_ENABLED_ADDONS: "gateway,voice" })).toBe(false);
    expect(remoteAddonEnabled({ OP_ENABLED_ADDONS: "gateway, remote" })).toBe(true);
  });
});

// ── The workspace address: operator → provider → derivable default ───────
//
// OpenCode's web UI is a root-mounted SPA, so it needs an ORIGIN, and only the
// thing fronting an install knows which origin that is. These pin the
// precedence and — more importantly — that the fallback is total: every
// topology gets an answer, so /advanced always has an address to probe.

describe("parseWorkspaceOrigin", () => {
  test("accepts a bare http(s) origin, with and without a port", () => {
    expect(parseWorkspaceOrigin("https://code.example.com")).toBe("https://code.example.com");
    expect(parseWorkspaceOrigin("http://192.168.1.10:3820")).toBe("http://192.168.1.10:3820");
    expect(parseWorkspaceOrigin("  https://code.example.com/  ")).toBe("https://code.example.com");
  });

  test("rejects anything an origin cannot carry", () => {
    // The SPA resolves /assets/*, /api/* and its routes against the ORIGIN, so
    // a path, query or fragment is silently discarded at the first request —
    // accepting one would advertise an address that loads the wrong app.
    expect(parseWorkspaceOrigin("https://code.example.com/workspace")).toBeNull();
    expect(parseWorkspaceOrigin("https://code.example.com/?a=1")).toBeNull();
    expect(parseWorkspaceOrigin("https://code.example.com/#frag")).toBeNull();
    // Credentials in a frame URL are not sent by any modern browser.
    expect(parseWorkspaceOrigin("https://user:pw@code.example.com")).toBeNull();
    expect(parseWorkspaceOrigin("ws://code.example.com")).toBeNull();
    expect(parseWorkspaceOrigin("code.example.com:3820")).toBeNull();
    expect(parseWorkspaceOrigin("   ")).toBeNull();
    expect(parseWorkspaceOrigin(undefined)).toBeNull();
  });
});

describe("resolveWorkspaceAdvertisement", () => {
  test("no remote edge: the derivable default, which the browser completes with its own host", () => {
    expect(resolveWorkspaceAdvertisement({})).toEqual({ kind: "port", port: 3820 });
    expect(resolveWorkspaceAdvertisement({ OP_WORKSPACE_PORT: "4820" })).toEqual({
      kind: "port",
      port: 4820,
    });
  });

  test("the operator's declared origin outranks everything", () => {
    expect(
      resolveWorkspaceAdvertisement({
        OP_WORKSPACE_ORIGIN: "https://code.example.com",
        OP_WORKSPACE_PORT: "4820",
        OP_ENABLED_ADDONS: "remote",
      }),
    ).toEqual({ kind: "absolute", origin: "https://code.example.com" });
  });

  test("an unusable operator value falls through rather than poisoning the answer", () => {
    // Fail-soft on purpose: a typo'd origin costs the default, not a workspace.
    expect(
      resolveWorkspaceAdvertisement({ OP_WORKSPACE_ORIGIN: "not a url", OP_WORKSPACE_PORT: "4820" }),
    ).toEqual({ kind: "port", port: 4820 });
  });

  test("the remote addon does not move the workspace — Tailscale serves the derived port", () => {
    // Tailscale gives a node ONE name and serves the workspace on a second port
    // of it, which is exactly what the default composes. There is deliberately
    // no per-provider hook: the one that existed returned byte-identical output
    // to this fallback, so it was an extension point with no user.
    expect(
      resolveWorkspaceAdvertisement({ OP_ENABLED_ADDONS: "remote", OP_WORKSPACE_PORT: "4820" }),
    ).toEqual({ kind: "port", port: 4820 });
    expect(
      resolveWorkspaceAdvertisement({ OP_REMOTE_PROFILE: "addon.remote.tailscale" }),
    ).toEqual({ kind: "port", port: 3820 });
  });

  test("no provider carries a workspace hook to drift out of sync with this", () => {
    // If one is ever added back, this fails and whoever adds it has to say so.
    for (const provider of Object.values(REMOTE_PROVIDERS)) {
      expect(provider, provider.id).not.toHaveProperty("workspaceOrigin");
    }
  });
});
