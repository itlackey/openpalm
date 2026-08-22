/**
 * `remote` addon (Tailscale tunnel) — compose-contract tests for the `tunnel`
 * service in services.compose.yml.
 *
 * Parses the shipped skeleton compose file directly (no Docker required),
 * mirroring network-partitioning.test.ts / compose-contract.test.ts's
 * approach: `parseComposeServices` (compose-services.ts) only models `name`,
 * `profiles`, and `labels`, so it is not enough here — this file needs
 * `volumes`, `networks`, `environment`, `secrets`, `image`, and the ABSENCE of
 * `ports`/`depends_on`, none of which that parser exposes. A raw `yaml.parse`
 * of the file, read straight off disk, is what every other test file in this
 * directory that needs those fields already does.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const STACK_DIR = join(REPO_ROOT, "packages/skeleton/system/stack");
const SERVICES_COMPOSE_PATH = join(STACK_DIR, "services.compose.yml");

type ComposeService = {
  profiles?: string[];
  image?: string;
  healthcheck?: ComposeHealthcheck;
  ports?: unknown[];
  depends_on?: unknown;
  networks?: string[] | Record<string, unknown>;
  volumes?: string[];
  environment?: Record<string, unknown>;
  secrets?: string[];
  user?: string;
};
type ComposeHealthcheck = {
  test?: string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  start_period?: string;
};
type ComposeFile = {
  services?: Record<string, ComposeService>;
  secrets?: Record<string, { file?: string }>;
};

function loadServicesCompose(): ComposeFile {
  return yamlParse(readFileSync(SERVICES_COMPOSE_PATH, "utf8")) as ComposeFile;
}

// Normalize both compose network forms — the list form `[a, b]` and the map
// form `{a: {aliases: [...]}}` — into a plain array of network names. Mirrors
// the helper of the same shape in network-partitioning.test.ts and
// addon-network-boundary.test.ts.
function serviceNetworks(networks: ComposeService["networks"]): string[] {
  if (!networks) return [];
  if (Array.isArray(networks)) return networks;
  return Object.keys(networks);
}

// Container-side target of a short-form mount. Interpolations come out first:
// the guarded `${OP_HOME:?}` mount sources carry a colon of their own, so a
// bare split(':') reads `?}/state/remote` as the target and every assertion
// built on it silently stops meaning anything.
function mountTarget(entry: string): string | undefined {
  return entry.replace(/\$\{[^}]*\}/g, "").split(":")[1];
}

const compose = loadServicesCompose();
const tunnel = compose.services?.tunnel;

describe("tunnel service — exists, profile-gated", () => {
  test("services.compose.yml declares a tunnel service", () => {
    expect(tunnel).toBeDefined();
  });

  test("tunnel is gated behind the Tailscale provider variant, and only it", () => {
    // The provider-variant profile (remote-access-providers.md §2): renamed
    // from the bare `addon.remote` when providers became variants of the one
    // remote addon. A bare enable still deploys this service through
    // resolveActiveProfiles' default-provider fallback, which
    // remote-providers.test.ts pins.
    expect(tunnel?.profiles).toEqual(["addon.remote.tailscale"]);
  });

  test("tunnel carries the provider selector's display labels, default on", () => {
    const labels = (tunnel?.labels ?? {}) as Record<string, string>;
    expect(labels["openpalm.profile.label"]).toBe("Tailscale");
    expect(labels["openpalm.profile.default"]).toBe("true");
  });
});

describe("tunnel service — no ports published", () => {
  test("tunnel declares no ports: block at all", () => {
    // Distinguish "key present but empty" from "key absent" — both would read
    // as falsy through a loose truthiness check, but only the latter is what
    // "publishes NOTHING on the host" actually requires here.
    expect(tunnel).not.toHaveProperty("ports");
  });
});

describe("tunnel service — no depends_on", () => {
  test("tunnel declares no depends_on (guardian is profile-gated; a depends_on onto it would be a stack-wide Compose parse error)", () => {
    expect(tunnel).not.toHaveProperty("depends_on");
  });
});

describe("tunnel service — readiness healthcheck", () => {
  test("uses Tailscale's built-in health endpoint, not process liveness", () => {
    expect(tunnel?.environment?.TS_ENABLE_HEALTH_CHECK).toBe("true");
    expect(tunnel?.environment?.TS_LOCAL_ADDR_PORT).toBe("127.0.0.1:9002");
    expect(tunnel?.healthcheck?.test).toEqual([
      "CMD",
      "wget",
      "--spider",
      "-q",
      "http://127.0.0.1:9002/healthz",
    ]);
  });

  test("allows containerboot's 60-second startup deadline before counting failures", () => {
    expect(tunnel?.healthcheck?.interval).toBe("10s");
    expect(tunnel?.healthcheck?.timeout).toBe("5s");
    expect(tunnel?.healthcheck?.retries).toBe(3);
    expect(tunnel?.healthcheck?.start_period).toBe("60s");
  });

  test("keeps the readiness probe local and does not widen the tunnel boundary", () => {
    expect(tunnel?.healthcheck?.test?.at(-1)).toBe("http://127.0.0.1:9002/healthz");
    expect(tunnel).not.toHaveProperty("ports");
    expect(tunnel).not.toHaveProperty("cap_add");
    expect(tunnel).not.toHaveProperty("devices");
    expect(tunnel?.user).toBe("${OP_UID:-1000}:${OP_GID:-1000}");
  });
});

describe("tunnel service — network reachability", () => {
  test("tunnel is on both assistant_net (to reach assistant) and portal_net (to reach guardian)", () => {
    const nets = serviceNetworks(tunnel?.networks);
    expect(nets).toContain("assistant_net");
    expect(nets).toContain("portal_net");
  });
});

describe("tunnel service — volume mounts are directories, at the right container paths", () => {
  test("mounts OP_HOME's remote serve-config dir at /config", () => {
    expect(tunnel?.volumes ?? []).toContain("${OP_HOME:?}/state/remote:/config");
  });

  test("REGRESSION: the /config source is NOT under system/, which is overwritten wholesale on update", () => {
    // overwriteSystemTree (core-assets.ts) replaces OP_HOME/system entirely
    // from the release skeleton on any update that changes a managed file —
    // it renames the old tree aside and moves a staged copy into place. The
    // skeleton ships no `remote/` directory, so a generated serve config kept
    // under system/ would be deleted along with the directory containerboot
    // watches, and containerboot log.Fatalf's when that watch cannot be
    // registered. The mount source must therefore live in a tree that
    // overwrite never touches.
    const configMount = (tunnel?.volumes ?? []).find((entry) => entry.endsWith(":/config"));
    expect(configMount).toBeDefined();
    expect(configMount).not.toContain("/system/");
  });

  test("mounts OP_HOME's tunnel state dir at /var/lib/tailscale", () => {
    expect(tunnel?.volumes ?? []).toContain("${OP_HOME:?}/data/tunnel:/var/lib/tailscale");
  });

  test("neither volumes entry is a bind of a single file (both sides of the ':' split stay directory paths, not the generated serve.json itself)", () => {
    for (const entry of tunnel?.volumes ?? []) {
      expect(mountTarget(entry)).not.toMatch(/serve\.json$/);
    }
  });
});

describe("tunnel service — TS_SERVE_CONFIG points inside the mounted /config directory", () => {
  test("TS_SERVE_CONFIG is /config/serve.json, i.e. inside the /config mount, not some other path", () => {
    expect(tunnel?.environment?.TS_SERVE_CONFIG).toBe("/config/serve.json");
    // Belt-and-suspenders: the env value's directory must be exactly the
    // container-side target of the /config volume mount above, so a future
    // edit to one side can't silently orphan the other.
    const configMount = (tunnel?.volumes ?? []).find((v) => v.endsWith(":/config"));
    expect(configMount).toBeDefined();
    expect(tunnel?.environment?.TS_SERVE_CONFIG).toBe(`${mountTarget(configMount ?? "")}/serve.json`);
  });
});

describe("tunnel service — TS_AUTHKEY is delivered via the secret file, never a literal", () => {
  test("TS_AUTHKEY uses the file: prefix pointing at the mounted compose secret", () => {
    expect(tunnel?.environment?.TS_AUTHKEY).toBe("file:/run/secrets/ts_authkey");
  });

  test("TS_AUTHKEY is not, and does not contain, a bare/literal key value", () => {
    const value = String(tunnel?.environment?.TS_AUTHKEY ?? "");
    expect(value.startsWith("file:")).toBe(true);
    // A real Tailscale auth key is "tskey-auth-..."; guard against a literal
    // ever being pasted in here instead of routed through the secret file.
    expect(value).not.toMatch(/tskey-/);
  });

  test("the ts_authkey secret is declared on the tunnel service", () => {
    expect(tunnel?.secrets ?? []).toContain("ts_authkey");
  });

  test("the ts_authkey secret is declared top-level, sourced from the delegated state secrets dir", () => {
    expect(compose.secrets?.ts_authkey?.file).toBe("${OP_HOME:?}/state/secrets/ts_authkey");
  });
});

describe("tunnel service — image is pinned, not floating", () => {
  test("the image tag is not :latest and not the :stable floating tag", () => {
    const image = tunnel?.image ?? "";
    expect(image).not.toMatch(/:latest(@|$)/);
    expect(image).not.toMatch(/:stable(@|$)/);
  });

  test("the image is the official tailscale/tailscale repository, pinned to a version tag", () => {
    const image = tunnel?.image ?? "";
    expect(image).toMatch(/^tailscale\/tailscale:v\d+\.\d+(\.\d+)?/);
  });
});

describe("tunnel service — other required fields (pins, guard against silent drift)", () => {
  test("restart: unless-stopped, matching every other service in this file", () => {
    expect((compose.services?.tunnel as unknown as { restart?: string })?.restart).toBe(
      "unless-stopped",
    );
  });

  test("json-file logging cap (IMG-7), matching every other service in this file", () => {
    const logging = (compose.services?.tunnel as unknown as {
      logging?: { driver?: string; options?: Record<string, string> };
    })?.logging;
    expect(logging?.driver).toBe("json-file");
    expect(logging?.options?.["max-size"]).toBe("10m");
    expect(logging?.options?.["max-file"]).toBe("3");
  });

  test("hostname is sourced from OP_REMOTE_HOSTNAME with the openpalm default", () => {
    expect((compose.services?.tunnel as unknown as { hostname?: string })?.hostname).toBe(
      "${OP_REMOTE_HOSTNAME:-openpalm}",
    );
  });

  test("TS_USERSPACE is explicitly true (no NET_ADMIN / /dev/net/tun required)", () => {
    expect(tunnel?.environment?.TS_USERSPACE).toBe("true");
  });

  test("TS_STATE_DIR matches the container-side target of the /var/lib/tailscale mount", () => {
    expect(tunnel?.environment?.TS_STATE_DIR).toBe("/var/lib/tailscale");
  });

  test("TS_ENABLE_HEALTH_CHECK is explicitly true", () => {
    expect(tunnel?.environment?.TS_ENABLE_HEALTH_CHECK).toBe("true");
  });

  /**
   * TS_SOCKET is load-bearing for the rootless `user:` below it, not a
   * preference. tailscaled's default LocalAPI socket lives under the
   * root-owned /var/run, which a non-root tailscaled cannot create — it
   * fails to start. Pairing a non-default socket path with `user:` is the
   * whole fix, so the two must never drift apart: dropping TS_SOCKET while
   * keeping `user:` breaks the tunnel outright, and it breaks it at
   * container start, where the failure is a crash loop rather than a clear
   * message.
   */
  test("TS_SOCKET is set to a path the rootless user can write", () => {
    expect(tunnel?.environment?.TS_SOCKET).toBe("/tmp/tailscaled.sock");
    expect(tunnel?.environment?.TS_SOCKET).not.toMatch(/^\/var\/run\//);
  });

  test("runs rootless as the operator uid/gid, like every other service here", () => {
    expect((compose.services?.tunnel as unknown as { user?: string })?.user).toBe(
      "${OP_UID:-1000}:${OP_GID:-1000}",
    );
  });
});
