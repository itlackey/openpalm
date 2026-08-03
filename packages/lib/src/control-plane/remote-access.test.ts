/**
 * Remote access (`remote` addon) config model and ServeConfig derivation.
 */
import { describe, expect, test } from "bun:test";
import {
  coerceRemoteAccessConfig,
  deriveRemoteHostname,
  describeRemoteExposure,
  readRemoteAccessConfig,
  REMOTE_ACCESS_DEFAULTS,
  REMOTE_TARGETS,
  type RemoteAccessConfig,
  resolveRemoteEnv,
  resolveRemoteHostname,
  resolveServeConfig,
} from "./remote-access.js";

describe("defaults", () => {
  test("private, assistant-only, no pinned hostname", () => {
    expect(REMOTE_ACCESS_DEFAULTS).toEqual({ hostname: "", public: false, target: "assistant" });
  });
});

describe("deriveRemoteHostname", () => {
  test("lowercases", () => {
    expect(deriveRemoteHostname("MyStack")).toBe("mystack");
  });

  test("maps spaces and underscores to hyphens", () => {
    expect(deriveRemoteHostname("my stack_name")).toBe("my-stack-name");
  });

  test("collapses runs of separators into one hyphen", () => {
    expect(deriveRemoteHostname("my___stack   name")).toBe("my-stack-name");
  });

  test("strips leading and trailing junk", () => {
    expect(deriveRemoteHostname("--openpalm--")).toBe("openpalm");
    expect(deriveRemoteHostname("!!!openpalm!!!")).toBe("openpalm");
  });

  test("truncates to 63 characters", () => {
    const long = "a".repeat(100);
    const result = deriveRemoteHostname(long);
    expect(result.length).toBe(63);
    expect(result).toBe("a".repeat(63));
  });

  test("re-strips a trailing hyphen introduced by truncation", () => {
    // 62 'a's followed by a hyphen, then more content — slicing at 63 lands
    // exactly on the hyphen, which must not survive into the result.
    const raw = `${"a".repeat(62)}-bbbb`;
    const result = deriveRemoteHostname(raw);
    expect(result.endsWith("-")).toBe(false);
    expect(result).toBe("a".repeat(62));
  });

  test("empty or all-junk input falls back to openpalm", () => {
    expect(deriveRemoteHostname("")).toBe("openpalm");
    expect(deriveRemoteHostname("   ")).toBe("openpalm");
    expect(deriveRemoteHostname("!!!___!!!")).toBe("openpalm");
  });
});

describe("resolveRemoteHostname", () => {
  test("derives from OP_PROJECT_NAME when no hostname is pinned", () => {
    expect(resolveRemoteHostname({ OP_PROJECT_NAME: "My Stack" })).toBe("my-stack");
  });

  test("defaults to openpalm when OP_PROJECT_NAME is also absent", () => {
    expect(resolveRemoteHostname({})).toBe("openpalm");
  });

  test("a pinned hostname wins over derivation, even if it looks different", () => {
    expect(
      resolveRemoteHostname({ OP_REMOTE_HOSTNAME: "my-pinned-name", OP_PROJECT_NAME: "other-stack" }),
    ).toBe("my-pinned-name");
  });

  test("a blank pinned hostname does not win — falls back to derivation", () => {
    expect(resolveRemoteHostname({ OP_REMOTE_HOSTNAME: "   ", OP_PROJECT_NAME: "other-stack" })).toBe(
      "other-stack",
    );
  });
});

describe("env round-trip", () => {
  test("resolveRemoteEnv -> readRemoteAccessConfig recovers the same config", () => {
    const cfg: RemoteAccessConfig = { hostname: "pinned-host", public: true, target: "both" };
    const env = resolveRemoteEnv(cfg);
    expect(readRemoteAccessConfig(env)).toEqual(cfg);
  });

  test("round-trips every target", () => {
    for (const target of ["assistant", "guardian", "both"] as const) {
      const cfg: RemoteAccessConfig = { hostname: "h", public: false, target };
      expect(readRemoteAccessConfig(resolveRemoteEnv(cfg))).toEqual(cfg);
    }
  });

  test("does not emit TS_AUTHKEY — it is @sensitive and routed to a secret file", () => {
    const env = resolveRemoteEnv({ hostname: "h", public: false, target: "assistant" });
    expect(env.TS_AUTHKEY).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(["OP_REMOTE_HOSTNAME", "OP_REMOTE_PUBLIC", "OP_REMOTE_TARGET"]);
  });
});

describe("readRemoteAccessConfig", () => {
  test("an empty env reads as the safe defaults (with derived hostname)", () => {
    expect(readRemoteAccessConfig({})).toEqual({ hostname: "openpalm", public: false, target: "assistant" });
  });

  test("unrecognised target falls back to assistant", () => {
    expect(readRemoteAccessConfig({ OP_REMOTE_TARGET: "nonsense" }).target).toBe("assistant");
    expect(readRemoteAccessConfig({}).target).toBe("assistant");
  });

  test.each(["true", "TRUE", "1", "yes", "on", " true "])("accepts %s as public", (value) => {
    expect(readRemoteAccessConfig({ OP_REMOTE_PUBLIC: value }).public).toBe(true);
  });

  test.each(["false", "FALSE", "0", "no", "off", "", "maybe"])("treats %s as private", (value) => {
    expect(readRemoteAccessConfig({ OP_REMOTE_PUBLIC: value }).public).toBe(false);
  });
});

describe("coerceRemoteAccessConfig", () => {
  test("defaults anything absent or wrongly typed", () => {
    expect(coerceRemoteAccessConfig({ public: true, hostname: 42 })).toEqual({
      hostname: "",
      public: true,
      target: "assistant",
    });
    expect(coerceRemoteAccessConfig(null)).toEqual(REMOTE_ACCESS_DEFAULTS);
    expect(coerceRemoteAccessConfig("nonsense")).toEqual(REMOTE_ACCESS_DEFAULTS);
  });

  test("rejects an unrecognised target string", () => {
    expect(coerceRemoteAccessConfig({ target: "everything" }).target).toBe("assistant");
  });

  test("accepts a fully well-formed value unchanged", () => {
    const cfg = { hostname: "pinned", public: true, target: "guardian" as const };
    expect(coerceRemoteAccessConfig(cfg)).toEqual(cfg);
  });
});

describe("resolveServeConfig", () => {
  test("target assistant, private", () => {
    expect(resolveServeConfig({ hostname: "h", public: false, target: "assistant" })).toEqual({
      TCP: { "443": { HTTPS: true } },
      Web: { "${TS_CERT_DOMAIN}:443": { Handlers: { "/": { Proxy: "http://assistant:3000" } } } },
      AllowFunnel: { "${TS_CERT_DOMAIN}:443": false },
    });
  });

  test("target assistant, public", () => {
    expect(resolveServeConfig({ hostname: "h", public: true, target: "assistant" })).toEqual({
      TCP: { "443": { HTTPS: true } },
      Web: { "${TS_CERT_DOMAIN}:443": { Handlers: { "/": { Proxy: "http://assistant:3000" } } } },
      AllowFunnel: { "${TS_CERT_DOMAIN}:443": true },
    });
  });

  test("target guardian, private — port 8443, not 443", () => {
    expect(resolveServeConfig({ hostname: "h", public: false, target: "guardian" })).toEqual({
      TCP: { "8443": { HTTPS: true } },
      Web: { "${TS_CERT_DOMAIN}:8443": { Handlers: { "/": { Proxy: "http://guardian:3830" } } } },
      AllowFunnel: { "${TS_CERT_DOMAIN}:8443": false },
    });
  });

  test("target guardian, public", () => {
    expect(resolveServeConfig({ hostname: "h", public: true, target: "guardian" })).toEqual({
      TCP: { "8443": { HTTPS: true } },
      Web: { "${TS_CERT_DOMAIN}:8443": { Handlers: { "/": { Proxy: "http://guardian:3830" } } } },
      AllowFunnel: { "${TS_CERT_DOMAIN}:8443": true },
    });
  });

  test("target both, private — both ports, both AllowFunnel entries false", () => {
    expect(resolveServeConfig({ hostname: "h", public: false, target: "both" })).toEqual({
      TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
      Web: {
        "${TS_CERT_DOMAIN}:443": { Handlers: { "/": { Proxy: "http://assistant:3000" } } },
        "${TS_CERT_DOMAIN}:8443": { Handlers: { "/": { Proxy: "http://guardian:3830" } } },
      },
      AllowFunnel: { "${TS_CERT_DOMAIN}:443": false, "${TS_CERT_DOMAIN}:8443": false },
    });
  });

  test("target both, public — both AllowFunnel entries true", () => {
    const doc = resolveServeConfig({ hostname: "h", public: true, target: "both" });
    expect(doc.AllowFunnel).toEqual({
      "${TS_CERT_DOMAIN}:443": true,
      "${TS_CERT_DOMAIN}:8443": true,
    });
  });

  test("AllowFunnel is always present with an explicit boolean, never omitted", () => {
    // The whole point: readServeConfig treats a missing/empty file as "no
    // change", so "public: false" must still write an explicit false rather
    // than omitting the key — omission would leave a prior funnel open.
    for (const target of ["assistant", "guardian", "both"] as const) {
      const doc = resolveServeConfig({ hostname: "h", public: false, target });
      const keys = Object.keys(doc.AllowFunnel);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(doc.AllowFunnel[key]).toBe(false);
      }
    }
  });

  test("keys are emitted in ascending port order for a stable, non-churning file", () => {
    const doc = resolveServeConfig({ hostname: "h", public: false, target: "both" });
    expect(Object.keys(doc.TCP)).toEqual(["443", "8443"]);
  });

  test("the ${TS_CERT_DOMAIN} placeholder is emitted literally, not interpolated", () => {
    const doc = resolveServeConfig({ hostname: "should-not-appear", public: false, target: "assistant" });
    const key = Object.keys(doc.Web)[0];
    expect(key).toBe("${TS_CERT_DOMAIN}:443");
    expect(key).not.toContain("should-not-appear");
  });
});

describe("describeRemoteExposure", () => {
  const cfg: RemoteAccessConfig = { hostname: "my-stack", public: false, target: "assistant" };

  test("says nothing when the addon is disabled, regardless of config", () => {
    expect(describeRemoteExposure({ ...cfg, public: true, target: "both" }, false)).toEqual([]);
  });

  test("private assistant: one line naming only-your-own-devices reach", () => {
    const lines = describeRemoteExposure(cfg, true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("assistant");
    expect(lines[0]).toContain("your own signed-in devices");
  });

  test("public target distinguishes 'anyone who has the address'", () => {
    const lines = describeRemoteExposure({ ...cfg, public: true }, true);
    expect(lines[0]).toContain("public internet");
    expect(lines[0]).toContain("anyone who has the address");
  });

  test("target both reports one line per service", () => {
    const lines = describeRemoteExposure({ ...cfg, target: "both" }, true);
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes("assistant"))).toBe(true);
    expect(lines.some((line) => line.includes("guardian"))).toBe(true);
  });

  test("names each service's port", () => {
    expect(describeRemoteExposure({ ...cfg, target: "guardian" }, true)[0]).toContain("port 8443");
    expect(describeRemoteExposure({ ...cfg, target: "assistant" }, true)[0]).toContain("port 443");
  });

  /**
   * Regression guard. The first implementation interpolated `cfg.hostname`
   * into a `https://…` string, but hostname is only the node LABEL — the
   * address that actually resolves is `https://<label>.<tailnet>.ts.net`, and
   * the tailnet suffix is assigned by Tailscale at registration. Printing a
   * bare-label URL hands the operator an address that does not exist.
   */
  test("never fabricates a URL from the bare node label", () => {
    for (const target of REMOTE_TARGETS) {
      for (const isPublic of [false, true]) {
        for (const line of describeRemoteExposure({ ...cfg, target, public: isPublic }, true)) {
          expect(line).not.toContain("https://");
          expect(line).not.toContain("my-stack");
        }
      }
    }
  });
});
