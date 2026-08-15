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

  test("missing target uses the safe assistant default", () => {
    expect(readRemoteAccessConfig({ OP_REMOTE_PUBLIC: "true" }).target).toBe("assistant");
  });

  test.each(["nonsense", "everything"])("rejects invalid target %j", (target) => {
    expect(() => readRemoteAccessConfig({ OP_REMOTE_TARGET: target })).toThrow(
      "Invalid OP_REMOTE_TARGET",
    );
  });

  test.each(["", "   "])("a blank target %j reads as unset — the credentials drawer persists OP_REMOTE_TARGET= verbatim", (target) => {
    expect(readRemoteAccessConfig({ OP_REMOTE_TARGET: target }).target).toBe("assistant");
  });

  test("public=true cannot turn an invalid target into assistant exposure", () => {
    expect(() =>
      resolveServeConfig(
        readRemoteAccessConfig({ OP_REMOTE_PUBLIC: "true", OP_REMOTE_TARGET: "nonsense" }),
      ),
    ).toThrow("Invalid OP_REMOTE_TARGET");
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
      TCP: { "443": { HTTPS: true }, "3820": { HTTPS: true } },
      Web: {
        "${TS_CERT_DOMAIN}:443": { Handlers: { "/": { Proxy: "http://assistant:3000" } } },
        "${TS_CERT_DOMAIN}:3820": { Handlers: { "/": { Proxy: "http://assistant:3820" } } },
      },
      AllowFunnel: { "${TS_CERT_DOMAIN}:443": false, "${TS_CERT_DOMAIN}:3820": false },
    });
  });

  test("target assistant, public", () => {
    expect(resolveServeConfig({ hostname: "h", public: true, target: "assistant" })).toEqual({
      TCP: { "443": { HTTPS: true }, "3820": { HTTPS: true } },
      Web: {
        "${TS_CERT_DOMAIN}:443": { Handlers: { "/": { Proxy: "http://assistant:3000" } } },
        "${TS_CERT_DOMAIN}:3820": { Handlers: { "/": { Proxy: "http://assistant:3820" } } },
      },
      // Funnel is 443/8443/10000 only, so the workspace could not be public
      // even if the operator asked — and a shell on the public internet is not
      // what "share my assistant" should mean.
      AllowFunnel: { "${TS_CERT_DOMAIN}:443": true, "${TS_CERT_DOMAIN}:3820": false },
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
      TCP: { "443": { HTTPS: true }, "3820": { HTTPS: true }, "8443": { HTTPS: true } },
      Web: {
        "${TS_CERT_DOMAIN}:443": { Handlers: { "/": { Proxy: "http://assistant:3000" } } },
        "${TS_CERT_DOMAIN}:3820": { Handlers: { "/": { Proxy: "http://assistant:3820" } } },
        "${TS_CERT_DOMAIN}:8443": { Handlers: { "/": { Proxy: "http://guardian:3830" } } },
      },
      AllowFunnel: {
        "${TS_CERT_DOMAIN}:443": false,
        "${TS_CERT_DOMAIN}:3820": false,
        "${TS_CERT_DOMAIN}:8443": false,
      },
    });
  });

  test("target both, public — the two service ports funnel, the workspace never does", () => {
    const doc = resolveServeConfig({ hostname: "h", public: true, target: "both" });
    expect(doc.AllowFunnel).toEqual({
      "${TS_CERT_DOMAIN}:443": true,
      "${TS_CERT_DOMAIN}:3820": false,
      "${TS_CERT_DOMAIN}:8443": true,
    });
  });

  test("the workspace rides with the assistant, never with the guardian alone", () => {
    // Guardian-only exposure publishes an API, not this app's UI — there is no
    // page there to frame a workspace from, so opening the port would be pure
    // attack surface.
    expect(
      Object.keys(resolveServeConfig({ hostname: "h", public: false, target: "guardian" }).TCP),
    ).toEqual(["8443"]);
  });

  test("follows a relocated workspace port so the entry cannot proxy a closed one", () => {
    const doc = resolveServeConfig({ hostname: "h", public: false, target: "assistant" }, 3999);
    expect(Object.keys(doc.TCP)).toEqual(["443", "3999"]);
    expect(doc.Web["${TS_CERT_DOMAIN}:3999"]).toEqual({
      Handlers: { "/": { Proxy: "http://assistant:3999" } },
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
    expect(Object.keys(doc.TCP)).toEqual(["443", "3820", "8443"]);
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

  test("private assistant: a line per door, naming only-your-own-devices reach", () => {
    // Two doors, because exposing the assistant also publishes OpenCode's
    // workspace — an operator reading "the assistant is reachable" would not
    // otherwise learn that a second port carrying a terminal went up with it.
    const lines = describeRemoteExposure(cfg, true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("assistant");
    expect(lines.some((line) => line.includes("assistant workspace"))).toBe(true);
    for (const line of lines) expect(line).toContain("your own signed-in devices");
  });

  test("the workspace door is disclosed as tailnet-only even when the rest is public", () => {
    const lines = describeRemoteExposure({ ...cfg, public: true }, true);
    const workspace = lines.find((line) => line.includes("workspace"));
    expect(workspace).toContain("your own signed-in devices");
    expect(workspace).not.toContain("public internet");
  });

  test("public target distinguishes 'anyone who has the address'", () => {
    const lines = describeRemoteExposure({ ...cfg, public: true }, true);
    expect(lines[0]).toContain("public internet");
    expect(lines[0]).toContain("anyone who has the address");
  });

  test("target both reports every door of every service", () => {
    const lines = describeRemoteExposure({ ...cfg, target: "both" }, true);
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes("port 443"))).toBe(true);
    expect(lines.some((line) => line.includes("port 3820"))).toBe(true);
    expect(lines.some((line) => line.includes("port 8443"))).toBe(true);
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
