/**
 * #563 — Network access preset resolver (TEST-FIRST, spec §2.1).
 *
 * `./network-preset.ts` does not exist yet — every test here fails at import
 * (RED). Once implemented, the resolver is the single source of truth for the
 * four network-access presets: `this-pc`, `home-password`, `home-open`, and
 * `shared-guardian`. Idioms mirrored from `bind-warning.test.ts` (plain
 * env-record in/out) and `setup.test.ts` (temp OP_HOME where needed).
 *
 * `resolveMdnsStatus` is imported from `./mdns-responder.js` in THIS TEST FILE
 * ONLY — `network-preset.ts` itself must stay browser-safe (no node imports,
 * per D1/§3.1) and never import the responder module.
 */
import { describe, test, expect } from "bun:test";
import {
  resolveNetworkPreset,
  detectNetworkPreset,
  validateNetworkPresetEnv,
  collectNetworkExposureWarnings,
  NETWORK_ACCESS_PRESETS,
  NETWORK_PRESET_LABELS,
  isNetworkAccessPreset,
  type NetworkAccessPreset,
} from "./network-preset.js";
import { assertNoSecretLikeStackEnvKeys } from "./secrets.js";
import { resolveMdnsStatus } from "./mdns-responder.js";

const HOME_PASSWORD = "lan-secret-123";

// ── T1-T4: preset resolution matrix ─────────────────────────────────────────

describe("resolveNetworkPreset — preset matrix", () => {
  test("T1: this-pc resolves the all-loopback row", () => {
    const r = resolveNetworkPreset("this-pc");
    expect(r.env).toEqual({
      OP_BIND_ADDRESS: "127.0.0.1",
      OP_ASSISTANT_BIND_ADDRESS: "127.0.0.1",
      OP_CLIENT_BIND_ADDRESS: "127.0.0.1",
      OP_VOICE_BIND_ADDRESS: "127.0.0.1",
      OPENCODE_AUTH: "false",
    });
    expect(r.assistantMdns).toBe(false);
    expect(r.guardianMdns).toBe(false);
    expect(r.opencodePassword).toBeUndefined();
  });

  test("T2: home-password exposes only the assistant and turns auth on", () => {
    const r = resolveNetworkPreset("home-password", { opencodePassword: HOME_PASSWORD });
    expect(r.env.OP_ASSISTANT_BIND_ADDRESS).toBe("0.0.0.0");
    expect(r.env.OP_BIND_ADDRESS).toBe("127.0.0.1");
    expect(r.env.OP_CLIENT_BIND_ADDRESS).toBe("127.0.0.1");
    expect(r.env.OP_VOICE_BIND_ADDRESS).toBe("127.0.0.1");
    expect(r.env.OPENCODE_AUTH).toBe("true");
    expect(r.opencodePassword).toBe(HOME_PASSWORD);
    expect(r.assistantMdns).toBe(true);
    expect(r.guardianMdns).toBe(false);
  });

  test("T3: home-open is the same exposure with auth off and no password", () => {
    const r = resolveNetworkPreset("home-open");
    expect(r.env.OP_ASSISTANT_BIND_ADDRESS).toBe("0.0.0.0");
    expect(r.env.OP_BIND_ADDRESS).toBe("127.0.0.1");
    expect(r.env.OP_CLIENT_BIND_ADDRESS).toBe("127.0.0.1");
    expect(r.env.OP_VOICE_BIND_ADDRESS).toBe("127.0.0.1");
    expect(r.env.OPENCODE_AUTH).toBe("false");
    expect(r.opencodePassword).toBeUndefined();
    expect(r.assistantMdns).toBe(true);
  });

  test("T4: shared-guardian exposes the guardian and hard-pins the assistant (and client/voice) to loopback", () => {
    const r = resolveNetworkPreset("shared-guardian");
    expect(r.env.OP_BIND_ADDRESS).toBe("0.0.0.0");
    expect(r.env.OP_ASSISTANT_BIND_ADDRESS).toBe("127.0.0.1");
    expect(r.env.OP_CLIENT_BIND_ADDRESS).toBe("127.0.0.1");
    expect(r.env.OP_VOICE_BIND_ADDRESS).toBe("127.0.0.1");
    expect(r.env.OPENCODE_AUTH).toBe("false");
    expect(r.guardianMdns).toBe(true);
    expect(r.assistantMdns).toBe(false);
  });

  test("T5: home-password without a password throws; a password on any other preset throws", () => {
    expect(() => resolveNetworkPreset("home-password")).toThrow();
    expect(() => resolveNetworkPreset("home-password", { opencodePassword: "" })).toThrow();
    expect(() => resolveNetworkPreset("this-pc", { opencodePassword: HOME_PASSWORD })).toThrow();
    expect(() => resolveNetworkPreset("home-open", { opencodePassword: HOME_PASSWORD })).toThrow();
    expect(() => resolveNetworkPreset("shared-guardian", { opencodePassword: HOME_PASSWORD })).toThrow();
  });

  test("T6: resolver env rows never contain secret-like keys", () => {
    for (const preset of NETWORK_ACCESS_PRESETS) {
      const opts = preset === "home-password" ? { opencodePassword: HOME_PASSWORD } : undefined;
      const r = resolveNetworkPreset(preset, opts);
      expect(() => assertNoSecretLikeStackEnvKeys(r.env)).not.toThrow();
    }
  });
});

// ── T7: mDNS intent-flag ↔ responder-gate equivalence (the D1 drift pin) ────

describe("resolveNetworkPreset — mDNS equivalence with the #488 responder (D1 pin)", () => {
  test("T7: preset mdns intent flags match the #488 responder gates", () => {
    for (const preset of NETWORK_ACCESS_PRESETS) {
      const opts = preset === "home-password" ? { opencodePassword: HOME_PASSWORD } : undefined;
      const r = resolveNetworkPreset(preset, opts);
      // Guardian advertisement additionally requires GUARDIAN_DIRECT_INGRESS
      // (PR #564 P2-1): a preset never enables ingress itself (the conservative
      // shared-guardian default leaves it off), so guardian discovery is only
      // REALIZED once the operator opts into direct ingress. The guardianMdns
      // flag encodes that INTENT; verify the responder honors it when ingress
      // is on, and (below) that it stays dark while ingress is off.
      // PR #564 retest P2-5: resolveMdnsStatus now shares the advertisement
      // path (advertised only when a real IPv4 record emits), so pass an
      // explicit host IPv4 for a deterministic wildcard-bind result.
      const HOST_IPV4 = ["192.168.1.20"];
      const withIngress = r.guardianMdns ? { ...r.env, GUARDIAN_DIRECT_INGRESS: "true" } : r.env;
      const status = resolveMdnsStatus(withIngress, HOST_IPV4);
      expect(status.assistant.advertised).toBe(r.assistantMdns);
      expect(status.guardian.advertised).toBe(r.guardianMdns);
      // Ingress off ⇒ guardian never advertised, regardless of intent.
      expect(resolveMdnsStatus(r.env, HOST_IPV4).guardian.advertised).toBe(false);
    }
  });
});

// ── T8-T12: detection ────────────────────────────────────────────────────────

describe("detectNetworkPreset", () => {
  test("T8: detectNetworkPreset({}) === 'this-pc' (unset keys are the compose loopback defaults)", () => {
    expect(detectNetworkPreset({})).toBe("this-pc");
  });

  test("T9: detect round-trips every resolver row", () => {
    for (const preset of NETWORK_ACCESS_PRESETS) {
      const opts = preset === "home-password" ? { opencodePassword: HOME_PASSWORD } : undefined;
      const r = resolveNetworkPreset(preset, opts);
      expect(detectNetworkPreset(r.env)).toBe(preset);
    }
  });

  test("T10: detect treats localhost/::1 as loopback and any other value as exposed", () => {
    expect(
      detectNetworkPreset({
        OP_BIND_ADDRESS: "localhost",
        OP_ASSISTANT_BIND_ADDRESS: "::1",
        OP_CLIENT_BIND_ADDRESS: "127.0.0.1",
        OP_VOICE_BIND_ADDRESS: "127.0.0.1",
        OPENCODE_AUTH: "false",
      }),
    ).toBe("this-pc");

    expect(
      detectNetworkPreset({
        OP_BIND_ADDRESS: "127.0.0.1",
        OP_ASSISTANT_BIND_ADDRESS: "192.168.1.20",
        OP_CLIENT_BIND_ADDRESS: "127.0.0.1",
        OP_VOICE_BIND_ADDRESS: "127.0.0.1",
        OPENCODE_AUTH: "true",
      }),
    ).toBe("home-password");
  });

  test("T11: detect returns null on drift", () => {
    // Assistant LAN + client LAN — not a shape any preset produces.
    expect(
      detectNetworkPreset({
        OP_BIND_ADDRESS: "127.0.0.1",
        OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0",
        OP_CLIENT_BIND_ADDRESS: "0.0.0.0",
        OP_VOICE_BIND_ADDRESS: "127.0.0.1",
        OPENCODE_AUTH: "false",
      }),
    ).toBeNull();

    // Shared row with auth on — shared-guardian never turns auth on.
    expect(
      detectNetworkPreset({
        OP_BIND_ADDRESS: "0.0.0.0",
        OP_ASSISTANT_BIND_ADDRESS: "127.0.0.1",
        OP_CLIENT_BIND_ADDRESS: "127.0.0.1",
        OP_VOICE_BIND_ADDRESS: "127.0.0.1",
        OPENCODE_AUTH: "true",
      }),
    ).toBeNull();
  });

  test("T12: detect ignores unmanaged keys", () => {
    expect(
      detectNetworkPreset({
        OP_BIND_ADDRESS: "127.0.0.1",
        OP_ASSISTANT_BIND_ADDRESS: "127.0.0.1",
        OP_CLIENT_BIND_ADDRESS: "127.0.0.1",
        OP_VOICE_BIND_ADDRESS: "127.0.0.1",
        OPENCODE_AUTH: "false",
        OP_CHAT_BIND_ADDRESS: "0.0.0.0",
      }),
    ).toBe("this-pc");
  });
});

// ── T13: env-combination validation ─────────────────────────────────────────

describe("validateNetworkPresetEnv", () => {
  test("T13: fails shared-guardian when the host env exposes the assistant", () => {
    const result = validateNetworkPresetEnv("shared-guardian", { OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("OP_ASSISTANT_BIND_ADDRESS"))).toBe(true);
    expect(result.errors.some((e) => e.includes("shared-guardian"))).toBe(true);
  });

  test("shared-guardian is valid when the host env is loopback/unset", () => {
    expect(validateNetworkPresetEnv("shared-guardian", {}).valid).toBe(true);
    expect(
      validateNetworkPresetEnv("shared-guardian", { OP_ASSISTANT_BIND_ADDRESS: "127.0.0.1" }).valid,
    ).toBe(true);
  });

  // PR #564 r3566887693: this-pc pins BOTH binds to loopback, so a leftover
  // host-env override that would expose either must fail closed (Compose gives
  // process env precedence over --env-file, so the written loopback row alone
  // does not protect against it).
  test("this-pc fails closed when the host env exposes the assistant", () => {
    const result = validateNetworkPresetEnv("this-pc", { OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("OP_ASSISTANT_BIND_ADDRESS"))).toBe(true);
    expect(result.errors.some((e) => e.includes("This PC only") || e.includes("this-pc"))).toBe(true);
  });

  test("this-pc fails closed when the host env exposes the guardian", () => {
    const result = validateNetworkPresetEnv("this-pc", { OP_BIND_ADDRESS: "0.0.0.0" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("OP_BIND_ADDRESS"))).toBe(true);
  });

  test("this-pc is valid when the host env is loopback/unset", () => {
    expect(validateNetworkPresetEnv("this-pc", {}).valid).toBe(true);
    expect(
      validateNetworkPresetEnv("this-pc", {
        OP_ASSISTANT_BIND_ADDRESS: "127.0.0.1",
        OP_BIND_ADDRESS: "127.0.0.1",
      }).valid,
    ).toBe(true);
  });

  test("home presets deliberately expose the assistant — always valid", () => {
    for (const preset of ["home-password", "home-open"] as NetworkAccessPreset[]) {
      expect(validateNetworkPresetEnv(preset, { OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0" }).valid).toBe(true);
    }
  });
});

// ── T14-T17: warning composition ────────────────────────────────────────────

describe("collectNetworkExposureWarnings", () => {
  test("T14: an exact home-password env collapses to one preset-framed line", () => {
    const env = resolveNetworkPreset("home-password", { opencodePassword: HOME_PASSWORD }).env;
    const warnings = collectNetworkExposureWarnings(env);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Home network, with password");
    expect(warnings[0]).toContain("OP_ASSISTANT_BIND_ADDRESS");
  });

  test("T15: home-open's preset line carries the open-access risk phrasing", () => {
    const env = resolveNetworkPreset("home-open").env;
    const warnings = collectNetworkExposureWarnings(env);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(NETWORK_PRESET_LABELS["home-open"]);
    expect(warnings[0]).toMatch(/without a password|open access|no password|anyone/i);
  });

  test("T15: shared-guardian's line names the guardian exposure and confirms the assistant stays loopback", () => {
    const env = resolveNetworkPreset("shared-guardian").env;
    const warnings = collectNetworkExposureWarnings(env);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(NETWORK_PRESET_LABELS["shared-guardian"]);
    expect(warnings[0]).toMatch(/assistant/i);
    expect(warnings[0]).toMatch(/loopback|private|127\.0\.0\.1|this pc/i);
  });

  test("T16: a non-loopback unmanaged var still warns individually under a matched preset", () => {
    const env = { ...resolveNetworkPreset("home-open").env, OP_CHAT_BIND_ADDRESS: "0.0.0.0" };
    const warnings = collectNetworkExposureWarnings(env);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.some((w) => w.includes(NETWORK_PRESET_LABELS["home-open"]))).toBe(true);
    expect(warnings.some((w) => w.includes("OP_CHAT_BIND_ADDRESS"))).toBe(true);
  });

  test("T17: no preset match falls back to the full per-var list; loopback env yields []", () => {
    // Drifted env: matches no preset row.
    const drifted = {
      OP_BIND_ADDRESS: "127.0.0.1",
      OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0",
      OP_CLIENT_BIND_ADDRESS: "0.0.0.0",
      OP_VOICE_BIND_ADDRESS: "127.0.0.1",
      OPENCODE_AUTH: "false",
    };
    const warnings = collectNetworkExposureWarnings(drifted);
    expect(warnings.some((w) => w.includes("OP_ASSISTANT_BIND_ADDRESS"))).toBe(true);
    expect(warnings.some((w) => w.includes("OP_CLIENT_BIND_ADDRESS"))).toBe(true);
    // No single collapsed preset line should be present for a drifted env.
    for (const preset of NETWORK_ACCESS_PRESETS) {
      expect(warnings.some((w) => w.includes(NETWORK_PRESET_LABELS[preset]))).toBe(false);
    }

    expect(collectNetworkExposureWarnings({})).toEqual([]);
  });

  test("T17: OP_ALLOW_REMOTE_SETUP still appends its line in both modes (pin)", () => {
    const matched = collectNetworkExposureWarnings({
      ...resolveNetworkPreset("this-pc").env,
      OP_ALLOW_REMOTE_SETUP: "1",
    });
    expect(matched.some((w) => w.includes("OP_ALLOW_REMOTE_SETUP"))).toBe(true);

    const unmatched = collectNetworkExposureWarnings({
      OP_BIND_ADDRESS: "127.0.0.1",
      OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0",
      OP_CLIENT_BIND_ADDRESS: "0.0.0.0",
      OP_ALLOW_REMOTE_SETUP: "1",
    });
    expect(unmatched.some((w) => w.includes("OP_ALLOW_REMOTE_SETUP"))).toBe(true);
  });
});

// ── Supporting exports sanity ────────────────────────────────────────────────

describe("supporting exports", () => {
  test("NETWORK_ACCESS_PRESETS lists exactly the four literals", () => {
    expect([...NETWORK_ACCESS_PRESETS].sort()).toEqual(
      ["home-open", "home-password", "shared-guardian", "this-pc"].sort(),
    );
  });

  test("NETWORK_PRESET_LABELS has the exact wizard/warning copy per preset", () => {
    expect(NETWORK_PRESET_LABELS["this-pc"]).toBe("This PC only");
    expect(NETWORK_PRESET_LABELS["home-password"]).toBe("Home network, with password");
    expect(NETWORK_PRESET_LABELS["home-open"]).toBe("Home network, open access");
    expect(NETWORK_PRESET_LABELS["shared-guardian"]).toBe("Shared network, guardian protected");
  });

  test("isNetworkAccessPreset narrows valid literals and rejects anything else", () => {
    expect(isNetworkAccessPreset("this-pc")).toBe(true);
    expect(isNetworkAccessPreset("home-password")).toBe(true);
    expect(isNetworkAccessPreset("bogus")).toBe(false);
    expect(isNetworkAccessPreset(undefined)).toBe(false);
    expect(isNetworkAccessPreset(null)).toBe(false);
    expect(isNetworkAccessPreset(42)).toBe(false);
  });
});
