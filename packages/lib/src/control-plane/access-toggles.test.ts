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
  readAccessToggles,
  requiresAssistantKey,
  resolveAccessEnv,
} from "./access-toggles.js";

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
      OPENCODE_AUTH: "false",
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
    expect(env.OPENCODE_AUTH).toBe("false");
  });

  test("OPENCODE_AUTH tracks assistantDirect exactly — auth iff published", () => {
    expect(resolveAccessEnv(on({ assistantDirect: true })).OPENCODE_AUTH).toBe("true");
    expect(resolveAccessEnv(on({ assistantDirect: false })).OPENCODE_AUTH).toBe("false");
    expect(requiresAssistantKey(on({ assistantDirect: true }))).toBe(true);
    expect(requiresAssistantKey(ALL_OFF)).toBe(false);
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
