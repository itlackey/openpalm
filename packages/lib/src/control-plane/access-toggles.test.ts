/**
 * Network access toggles.
 *
 * The property that matters and that the preset model could not provide: every
 * combination is representable, so nothing has to be inferred and nothing
 * reads as "custom".
 */
import { describe, expect, test } from "bun:test";
import {
  ACCESS_TOGGLE_DEFAULTS,
  ACCESS_TOGGLE_KEYS,
  type AccessToggles,
  coerceAccessToggles,
  describeAccessExposure,
  hasStoredAccessIntent,
  migrateLegacyAccessEnv,
  readAccessToggles,
  remoteRequiresGuardianIngress,
  resolveAccessEnv,
  resolveAccessIntentEnv,
  RETIRED_BIND_KEYS,
} from "./access-toggles.js";
import type { RemoteTarget } from "./remote-access.js";

const ALL_OFF = ACCESS_TOGGLE_DEFAULTS;
const on = (overrides: Partial<AccessToggles>): AccessToggles => ({ ...ALL_OFF, ...overrides });

describe("defaults", () => {
  test("a fresh install opens nothing", () => {
    expect(ALL_OFF).toEqual({
      networkAccess: false,
      assistantDirect: false,
      guardianNetwork: false,
      guardianOpenaiApi: false,
    });
  });

  test("all-off derives an all-loopback row with auth off", () => {
    expect(resolveAccessEnv(ALL_OFF)).toEqual({
      OP_UI_BIND_ADDRESS: "127.0.0.1",
      OP_ASSISTANT_BIND_ADDRESS: "127.0.0.1",
      OP_GUARDIAN_BIND_ADDRESS: "127.0.0.1",
      OP_API_BIND_ADDRESS: "127.0.0.1",
      GUARDIAN_DIRECT_INGRESS: "false",
    });
  });
});

describe("resolveAccessEnv", () => {
  test("network access publishes ONLY the UI — OpenCode stays loopback", () => {
    // The point of the same-origin /oc proxy: one listener, one credential.
    const env = resolveAccessEnv(on({ networkAccess: true }));
    expect(env.OP_UI_BIND_ADDRESS).toBe("0.0.0.0");
    expect(env.OP_ASSISTANT_BIND_ADDRESS).toBe("127.0.0.1");
  });

  test("assistantDirect moves only the bind — auth is always on and not a row", () => {
    expect(resolveAccessEnv(on({ assistantDirect: true }))).not.toHaveProperty("OPENCODE_AUTH");
    expect(resolveAccessEnv(on({ assistantDirect: true })).OP_ASSISTANT_BIND_ADDRESS).toBe("0.0.0.0");
  });

  test("each toggle moves exactly one bind — no cascade", () => {
    const keyFor: Record<keyof AccessToggles, keyof ReturnType<typeof resolveAccessEnv>> = {
      networkAccess: "OP_UI_BIND_ADDRESS",
      assistantDirect: "OP_ASSISTANT_BIND_ADDRESS",
      guardianNetwork: "OP_GUARDIAN_BIND_ADDRESS",
      guardianOpenaiApi: "OP_API_BIND_ADDRESS",
    };
    for (const toggle of ACCESS_TOGGLE_KEYS) {
      const env = resolveAccessEnv(on({ [toggle]: true }));
      for (const [other, bind] of Object.entries(keyFor)) {
        expect(env[bind]).toBe(other === toggle ? "0.0.0.0" : "127.0.0.1");
      }
    }
  });

  test("GUARDIAN_DIRECT_INGRESS tracks guardianNetwork — a published port must not 404", () => {
    expect(resolveAccessEnv(on({ guardianNetwork: true })).GUARDIAN_DIRECT_INGRESS).toBe("true");
    expect(resolveAccessEnv(ALL_OFF).GUARDIAN_DIRECT_INGRESS).toBe("false");
  });

  test("expresses a combination no preset could: LAN UI + guardian + OpenAI API", () => {
    const env = resolveAccessEnv(
      on({ networkAccess: true, guardianNetwork: true, guardianOpenaiApi: true }),
    );
    expect(env.OP_UI_BIND_ADDRESS).toBe("0.0.0.0");
    expect(env.OP_GUARDIAN_BIND_ADDRESS).toBe("0.0.0.0");
    expect(env.OP_API_BIND_ADDRESS).toBe("0.0.0.0");
    expect(env.OP_ASSISTANT_BIND_ADDRESS).toBe("127.0.0.1");
  });
});

// ── resolveAccessEnv's second, optional argument (the `remote` addon's need) ──

describe("resolveAccessEnv with no second argument", () => {
  test("is byte-identical to the pre-`remote` output for all 16 toggle combinations", () => {
    // The regression guard for every existing call site (setup.ts,
    // config-persistence.ts, and every caller yet to be written): omitting
    // opts must reproduce today's GUARDIAN_DIRECT_INGRESS-tracks-
    // guardianNetwork-alone behaviour exactly, with no drift from a default
    // argument value sneaking in.
    for (let mask = 0; mask < 16; mask += 1) {
      const toggles: AccessToggles = {
        networkAccess: Boolean(mask & 1),
        assistantDirect: Boolean(mask & 2),
        guardianNetwork: Boolean(mask & 4),
        guardianOpenaiApi: Boolean(mask & 8),
      };
      expect(resolveAccessEnv(toggles)).toEqual({
        OP_UI_BIND_ADDRESS: toggles.networkAccess ? "0.0.0.0" : "127.0.0.1",
        OP_ASSISTANT_BIND_ADDRESS: toggles.assistantDirect ? "0.0.0.0" : "127.0.0.1",
        OP_GUARDIAN_BIND_ADDRESS: toggles.guardianNetwork ? "0.0.0.0" : "127.0.0.1",
        OP_API_BIND_ADDRESS: toggles.guardianOpenaiApi ? "0.0.0.0" : "127.0.0.1",
        GUARDIAN_DIRECT_INGRESS: toggles.guardianNetwork ? "true" : "false",
      });
    }
  });
});

describe("resolveAccessEnv with guardianIngressRequired — the `remote` addon's need", () => {
  test("guardianNetwork off + remote targeting guardian: ingress answers, LAN bind stays shut", () => {
    // This is the whole point of the change: the tunnel reaches the guardian
    // over portal_net, not the LAN bind, so the listener must answer without
    // the bind moving.
    const env = resolveAccessEnv(ALL_OFF, { guardianIngressRequired: true });
    expect(env.GUARDIAN_DIRECT_INGRESS).toBe("true");
    expect(env.OP_GUARDIAN_BIND_ADDRESS).toBe("127.0.0.1");
  });

  test("guardianNetwork off + remote targeting both: same — ingress answers, LAN bind stays shut", () => {
    const env = resolveAccessEnv(ALL_OFF, { guardianIngressRequired: true });
    expect(env.GUARDIAN_DIRECT_INGRESS).toBe("true");
    expect(env.OP_GUARDIAN_BIND_ADDRESS).toBe("127.0.0.1");
  });

  test("guardianNetwork off + remote targeting assistant only: ingress stays shut", () => {
    // remoteRequiresGuardianIngress(true, "assistant") is false — a tunnel
    // that never reaches the guardian must not turn its listener on.
    const env = resolveAccessEnv(ALL_OFF, { guardianIngressRequired: false });
    expect(env.GUARDIAN_DIRECT_INGRESS).toBe("false");
    expect(env.OP_GUARDIAN_BIND_ADDRESS).toBe("127.0.0.1");
  });

  test("guardianNetwork on: bind is LAN regardless of the remote addon", () => {
    const withRemote = resolveAccessEnv(on({ guardianNetwork: true }), {
      guardianIngressRequired: true,
    });
    const withoutRemote = resolveAccessEnv(on({ guardianNetwork: true }), {
      guardianIngressRequired: false,
    });
    expect(withRemote.OP_GUARDIAN_BIND_ADDRESS).toBe("0.0.0.0");
    expect(withoutRemote.OP_GUARDIAN_BIND_ADDRESS).toBe("0.0.0.0");
    expect(withRemote.GUARDIAN_DIRECT_INGRESS).toBe("true");
    expect(withoutRemote.GUARDIAN_DIRECT_INGRESS).toBe("true");
  });

  test("remote disabled (guardianIngressRequired: false) has no effect, whatever guardianNetwork is", () => {
    expect(resolveAccessEnv(ALL_OFF, { guardianIngressRequired: false })).toEqual(
      resolveAccessEnv(ALL_OFF),
    );
    expect(
      resolveAccessEnv(on({ guardianNetwork: true }), { guardianIngressRequired: false }),
    ).toEqual(resolveAccessEnv(on({ guardianNetwork: true })));
  });

  test("only GUARDIAN_DIRECT_INGRESS moves — every other key is unaffected by the option", () => {
    for (let mask = 0; mask < 16; mask += 1) {
      const toggles: AccessToggles = {
        networkAccess: Boolean(mask & 1),
        assistantDirect: Boolean(mask & 2),
        guardianNetwork: Boolean(mask & 4),
        guardianOpenaiApi: Boolean(mask & 8),
      };
      const without = resolveAccessEnv(toggles);
      const withRequired = resolveAccessEnv(toggles, { guardianIngressRequired: true });
      expect({ ...withRequired, GUARDIAN_DIRECT_INGRESS: without.GUARDIAN_DIRECT_INGRESS }).toEqual(
        without,
      );
    }
  });
});

describe("remoteRequiresGuardianIngress", () => {
  test("truth table: true only when enabled AND the target reaches the guardian", () => {
    const targets: RemoteTarget[] = ["assistant", "guardian", "both"];
    const expected: Record<RemoteTarget, boolean> = {
      assistant: false,
      guardian: true,
      both: true,
    };
    for (const target of targets) {
      expect(remoteRequiresGuardianIngress(true, target)).toBe(expected[target]);
      expect(remoteRequiresGuardianIngress(false, target)).toBe(false);
    }
  });
});

describe("readAccessToggles", () => {
  test("round-trips every combination — nothing is unrepresentable", () => {
    for (let mask = 0; mask < 16; mask += 1) {
      const toggles: AccessToggles = {
        networkAccess: Boolean(mask & 1),
        assistantDirect: Boolean(mask & 2),
        guardianNetwork: Boolean(mask & 4),
        guardianOpenaiApi: Boolean(mask & 8),
      };
      expect(readAccessToggles(resolveAccessEnv(toggles))).toEqual(toggles);
    }
  });

  test("an empty env reads as all-off", () => {
    expect(readAccessToggles({})).toEqual(ALL_OFF);
  });

  test("treats every loopback spelling as closed", () => {
    for (const value of ["127.0.0.1", "localhost", "::1", "  127.0.0.1  "]) {
      expect(readAccessToggles({ OP_UI_BIND_ADDRESS: value }).networkAccess).toBe(false);
    }
  });

  test("a concrete LAN IP counts as open, not just the wildcard", () => {
    expect(readAccessToggles({ OP_UI_BIND_ADDRESS: "192.168.1.50" }).networkAccess).toBe(true);
  });

  describe("legacy rows", () => {
    test("OP_BIND_ADDRESS was the cascade root — it opens the UI, guardian and API", () => {
      expect(readAccessToggles({ OP_BIND_ADDRESS: "0.0.0.0" })).toEqual({
        networkAccess: true,
        assistantDirect: false,
        guardianNetwork: true,
        guardianOpenaiApi: true,
      });
    });

    test("a legacy home preset maps to assistantDirect, not networkAccess", () => {
      // The old home presets exposed OpenCode and left the UI on loopback.
      expect(
        readAccessToggles({
          OP_BIND_ADDRESS: "127.0.0.1",
          OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0",
          OP_UI_BIND_ADDRESS: "127.0.0.1",
        }),
      ).toEqual({
        networkAccess: false,
        assistantDirect: true,
        guardianNetwork: false,
        guardianOpenaiApi: false,
      });
    });

    test("the retired OP_CHAT_BIND_ADDRESS maps onto the OpenAI API toggle", () => {
      // Both chat and api published the guardian's single :8182 listener.
      expect(readAccessToggles({ OP_CHAT_BIND_ADDRESS: "0.0.0.0" }).guardianOpenaiApi).toBe(true);
    });

    test("an explicit loopback beats a LAN cascade root — the cascade's own precedence", () => {
      // The shared-guardian row: everything published EXCEPT the UI, which was
      // pinned to loopback on purpose. Reading this with a plain OR reports
      // networkAccess: true, and the next deploy writes 0.0.0.0 back — turning
      // a rerun into a silent exposure of a door the operator closed.
      const legacy = {
        OP_BIND_ADDRESS: "0.0.0.0",
        OP_UI_BIND_ADDRESS: "127.0.0.1",
      };
      expect(readAccessToggles(legacy)).toEqual({
        networkAccess: false,
        assistantDirect: false,
        guardianNetwork: true,
        guardianOpenaiApi: true,
      });
      expect(migrateLegacyAccessEnv(legacy).OP_UI_BIND_ADDRESS).toBe("127.0.0.1");
    });
  });
});

describe("migrateLegacyAccessEnv", () => {
  test("materializes the flat row the retired cascade would have produced", () => {
    expect(migrateLegacyAccessEnv({ OP_BIND_ADDRESS: "0.0.0.0" })).toEqual({
      OP_UI_BIND_ADDRESS: "0.0.0.0",
      OP_ASSISTANT_BIND_ADDRESS: "127.0.0.1",
      OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0",
      OP_API_BIND_ADDRESS: "0.0.0.0",
      GUARDIAN_DIRECT_INGRESS: "true",
    });
  });

  test("GUARDIAN_DIRECT_INGRESS is materialized, so a migrated port does not 404", () => {
    // The legacy row never carried this key — the guardian defaulted its direct
    // listener off. Migrating a published guardian without setting it would
    // leave the operator's own paired devices talking to a 404.
    expect(migrateLegacyAccessEnv({ OP_GUARDIAN_BIND_ADDRESS: "0.0.0.0" }).GUARDIAN_DIRECT_INGRESS)
      .toBe("true");
  });

  test("an already-flat row survives a re-migration unchanged", () => {
    const flat = resolveAccessEnv(on({ networkAccess: true, guardianOpenaiApi: true }));
    expect(migrateLegacyAccessEnv(flat)).toEqual(flat);
  });

  test("names every key the flat model retires", () => {
    expect([...RETIRED_BIND_KEYS]).toEqual([
      "OP_BIND_ADDRESS",
      "OP_CHAT_BIND_ADDRESS",
      "OP_VOICE_BIND_ADDRESS",
    ]);
  });
});

describe("coerceAccessToggles", () => {
  test("defaults anything absent or wrongly typed", () => {
    expect(coerceAccessToggles({ networkAccess: true, assistantDirect: "yes" })).toEqual(
      on({ networkAccess: true }),
    );
    expect(coerceAccessToggles(null)).toEqual(ALL_OFF);
    expect(coerceAccessToggles("nonsense")).toEqual(ALL_OFF);
  });
});

describe("describeAccessExposure", () => {
  test("says nothing when nothing is open", () => {
    expect(describeAccessExposure(ALL_OFF)).toEqual([]);
  });

  test("names the plain-HTTP exposure of a directly published assistant", () => {
    const lines = describeAccessExposure(on({ assistantDirect: true }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("readable");
  });

  test("reports one line per opened door", () => {
    expect(
      describeAccessExposure(on({ networkAccess: true, guardianNetwork: true })),
    ).toHaveLength(2);
  });
});

// ── Stored intent (the fix for "intent stored only as its own consequences") ──

describe("stored access intent", () => {
  test("resolveAccessIntentEnv writes one boolean per toggle", () => {
    expect(resolveAccessIntentEnv({ ...ACCESS_TOGGLE_DEFAULTS, networkAccess: true })).toEqual({
      OP_ACCESS_NETWORK: "true",
      OP_ACCESS_ASSISTANT_DIRECT: "false",
      OP_ACCESS_GUARDIAN: "false",
      OP_ACCESS_OPENAI_API: "false",
    });
  });

  test("stored intent WINS over the bind addresses it generated", () => {
    // This is the whole point. A row where the two disagree used to be read as
    // "open" from the bind, and the next save made that reading real —
    // publishing a surface the operator had deliberately kept private.
    const env = {
      OP_ACCESS_NETWORK: "false",
      OP_UI_BIND_ADDRESS: "0.0.0.0",
    };
    expect(readAccessToggles(env).networkAccess).toBe(false);
  });

  test("stored intent also wins over a retired cascade root", () => {
    const env = {
      OP_ACCESS_NETWORK: "false",
      OP_ACCESS_GUARDIAN: "false",
      OP_BIND_ADDRESS: "0.0.0.0",
    };
    const toggles = readAccessToggles(env);
    expect(toggles.networkAccess).toBe(false);
    expect(toggles.guardianNetwork).toBe(false);
  });

  test("inference is the fallback ONLY for a key with no stored intent", () => {
    // A row mid-upgrade: one key recorded, the rest still implied by binds.
    const env = {
      OP_ACCESS_NETWORK: "true",
      OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0",
    };
    const toggles = readAccessToggles(env);
    expect(toggles.networkAccess).toBe(true);
    expect(toggles.assistantDirect).toBe(true);
  });

  test.each(["true", "TRUE", "1", "yes", "on", " true "])("accepts %s as on", (value) => {
    expect(readAccessToggles({ OP_ACCESS_NETWORK: value }).networkAccess).toBe(true);
  });

  test.each(["false", "FALSE", "0", "no", "off"])("accepts %s as off", (value) => {
    expect(readAccessToggles({ OP_ACCESS_NETWORK: value, OP_UI_BIND_ADDRESS: "0.0.0.0" }).networkAccess).toBe(false);
  });

  test("an unparseable stored value falls back to inference rather than guessing", () => {
    expect(
      readAccessToggles({ OP_ACCESS_NETWORK: "maybe", OP_UI_BIND_ADDRESS: "0.0.0.0" }).networkAccess,
    ).toBe(true);
  });

  test("hasStoredAccessIntent is true only when every key is recorded", () => {
    expect(hasStoredAccessIntent({})).toBe(false);
    expect(hasStoredAccessIntent({ OP_ACCESS_NETWORK: "true" })).toBe(false);
    expect(hasStoredAccessIntent(resolveAccessIntentEnv(ACCESS_TOGGLE_DEFAULTS))).toBe(true);
  });

  test("intent round-trips through the generated row", () => {
    for (const key of ACCESS_TOGGLE_KEYS) {
      const toggles = { ...ACCESS_TOGGLE_DEFAULTS, [key]: true };
      const env = { ...resolveAccessIntentEnv(toggles), ...resolveAccessEnv(toggles) };
      expect(readAccessToggles(env)).toEqual(toggles);
    }
  });
});
