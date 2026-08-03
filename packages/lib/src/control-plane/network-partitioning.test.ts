/**
 * D5a — Network Partitioning + mDNS Fixture Tests
 *
 * Parses the managed compose YAML files directly (no Docker required) and
 * asserts the security invariants described in docs/technical/network-partitioning-d5a.md.
 *
 * Invariants checked:
 * 1. assistant_net contains only authorised services (guardian + assistant + internal AI).
 * 2. No portal adapter or Guardian-compatible API edge is on assistant_net.
 * 3. mDNS is published in-process by OpenCode (native server.mdns/mdnsDomain),
 *    NOT by avahi sidecars — the mdns-guardian/mdns-assistant services are gone.
 * 4. The assistant ships mDNS OFF by default (LAN-first); the guardian moderator
 *    stays loopback-bound with mDNS off.
 * 5. The assistant host port defaults to loopback (127.0.0.1).
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

// Resolve the compose files relative to the repo root.
// __dirname = packages/lib/src/control-plane/
const REPO_ROOT = join(import.meta.dir, "../../../..");
const STACK_DIR = join(REPO_ROOT, "packages/skeleton/system/stack");

function loadCompose(filename: string): Record<string, unknown> {
  const raw = readFileSync(join(STACK_DIR, filename), "utf8");
  return yamlParse(raw) as Record<string, unknown>;
}

type ComposeDoc = {
  services?: Record<
    string,
    {
      networks?: string[] | Record<string, unknown>;
      profiles?: string[];
      ports?: string[];
      environment?: Record<string, string> | string[];
      command?: string;
    }
  >;
};

function getServiceNetworks(service: ComposeDoc["services"][string]): string[] {
  if (!service.networks) return [];
  if (Array.isArray(service.networks)) return service.networks as string[];
  // object form: { assistant_net: { aliases: [...] } }
  return Object.keys(service.networks as Record<string, unknown>);
}

// ── Load all managed compose files ──────────────────────────────────────────

const core = loadCompose("core.compose.yml") as ComposeDoc;
const services = loadCompose("services.compose.yml") as ComposeDoc;
const channels = loadCompose("portals.compose.yml") as ComposeDoc;

// Collect all services across files with their declared networks.
const allServices: Record<string, { networks: string[]; profiles?: string[]; ports?: string[]; command?: string }> = {};

for (const [name, svc] of Object.entries(core.services ?? {})) {
  allServices[name] = {
    networks: getServiceNetworks(svc),
    profiles: svc.profiles,
    ports: svc.ports as string[] | undefined,
    command: svc.command as string | undefined,
  };
}
for (const [name, svc] of Object.entries(services.services ?? {})) {
  allServices[name] = {
    networks: getServiceNetworks(svc),
    profiles: svc.profiles,
    ports: svc.ports as string[] | undefined,
  };
}
for (const [name, svc] of Object.entries(channels.services ?? {})) {
  allServices[name] = {
    networks: getServiceNetworks(svc),
    profiles: svc.profiles,
    ports: svc.ports as string[] | undefined,
  };
}

// ── Helper ────────────────────────────────────────────────────────────────

function servicesOnNetwork(net: string): string[] {
  return Object.entries(allServices)
    .filter(([, s]) => s.networks.includes(net))
    .map(([name]) => name);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("network partitioning — assistant_net membership", () => {
  // Services that are allowed on assistant_net.
  // Internal AI inference services (ollama, voice variants) may be present;
  // portal adapters must NOT be.
  const ALLOWED_ON_ASSISTANT_NET = new Set([
    "assistant",
    "guardian",
    "ollama",
    "ollama-cuda",
    "ollama-rocm",
    "voice",
    "voice-cuda",
    "voice-rocm",
    // tunnel is not a third-party addon: it is the INGRESS PATH for
    // assistant/guardian (the only two services it ever proxies to), so it
    // gets the same per-service assistant_net exception as ollama — see the
    // trust-boundary header comment atop services.compose.yml.
    "tunnel",
  ]);

  // Portal adapters — these must NEVER be on assistant_net.
  const PORTAL_ADAPTERS = ["discord", "slack"];

  test("assistant is on assistant_net", () => {
    expect(allServices.assistant?.networks).toContain("assistant_net");
  });

  test("guardian is on assistant_net", () => {
    expect(allServices.guardian?.networks).toContain("assistant_net");
  });

  test("no portal adapter is on assistant_net", () => {
    for (const adapter of PORTAL_ADAPTERS) {
      const nets = allServices[adapter]?.networks ?? [];
      expect(nets).not.toContain("assistant_net");
    }
  });

  test("all services on assistant_net are in the authorised set", () => {
    const onNet = servicesOnNetwork("assistant_net");
    const unauthorised = onNet.filter((name) => !ALLOWED_ON_ASSISTANT_NET.has(name));
    expect(unauthorised).toEqual([]);
  });

  test("portal adapters are on portal_net only", () => {
    const PORTAL_ADAPTERS_IN_STACK = ["discord", "slack"];
    for (const adapter of PORTAL_ADAPTERS_IN_STACK) {
      const nets = allServices[adapter]?.networks ?? [];
      expect(nets).toContain("portal_net");
      expect(nets).not.toContain("assistant_net");
    }
  });

  test("guardian is on portal_net (the ingress bridge)", () => {
    expect(allServices.guardian?.networks).toContain("portal_net");
  });
});

describe("network partitioning — assistant host port defaults", () => {
  test("assistant host port defaults to loopback (127.0.0.1)", () => {
    const assistantPorts = allServices.assistant?.ports ?? [];
    // The port entry must contain the loopback default.
    // Pattern: "${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:..."
    const hasLoopbackDefault = assistantPorts.some((p) =>
      p.includes("127.0.0.1") || p.includes("OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1")
    );
    expect(hasLoopbackDefault).toBe(true);
  });
});

describe("mDNS — native OpenCode responder (no avahi sidecars)", () => {
  // mDNS is now published in-process by OpenCode (server.mdns / server.mdnsDomain
  // in the assistant + guardian opencode.jsonc files). The avahi `apk add`
  // sidecars (mdns-guardian / mdns-assistant) have been removed entirely.
  //
  // JSONC config files carry comments, so strip line comments before parsing.
  function loadJsonc(relPath: string): Record<string, unknown> {
    const raw = readFileSync(join(REPO_ROOT, relPath), "utf8");
    const stripped = raw
      .split("\n")
      .map((line) => {
        // Remove // comments that are not inside a string. Our config files only
        // use whole-line or trailing comments with no `//` inside string values,
        // so a conservative split on `//` outside quotes is safe here.
        const idx = line.indexOf("//");
        if (idx === -1) return line;
        // Bail if there is a quote before the comment marker on this line —
        // keep the line as-is to avoid corrupting a URL/value. None of the
        // server.* lines we assert on contain `//`, so this is sufficient.
        const before = line.slice(0, idx);
        const quotes = (before.match(/"/g) ?? []).length;
        if (quotes % 2 !== 0) return line; // inside a string — leave it
        return before;
      })
      .join("\n");
    return JSON.parse(stripped) as Record<string, unknown>;
  }

  const assistantConfig = loadJsonc("packages/skeleton/system/assistant/opencode.jsonc");
  const guardianConfig = loadJsonc("packages/skeleton/system/guardian/opencode.jsonc");

  type ServerCfg = { server?: { mdns?: boolean; mdnsDomain?: string; hostname?: string } };

  test("avahi sidecar services are removed from core.compose.yml", () => {
    expect(core.services?.["mdns-guardian"]).toBeUndefined();
    expect(core.services?.["mdns-assistant"]).toBeUndefined();
  });

  test("no compose service installs avahi via apk add", () => {
    const allCommands = Object.values(core.services ?? {})
      .map((s) => (s as { command?: unknown }).command)
      .filter((c): c is string => typeof c === "string");
    for (const cmd of allCommands) {
      expect(cmd).not.toMatch(/avahi/);
      expect(cmd).not.toMatch(/apk add/);
    }
  });

  test("assistant ships mDNS OFF by default (LAN-first)", () => {
    const server = (assistantConfig as ServerCfg).server;
    expect(server?.mdns).toBe(false);
  });

  test("assistant declares an mdnsDomain (.local host name) for native publish", () => {
    const server = (assistantConfig as ServerCfg).server;
    expect(typeof server?.mdnsDomain).toBe("string");
    expect(server?.mdnsDomain).toMatch(/\.local$/);
  });

  test("guardian moderator keeps mDNS OFF and stays loopback-bound", () => {
    const server = (guardianConfig as ServerCfg).server;
    expect(server?.mdns).toBe(false);
    // Loopback hostname is the security invariant — native mDNS self-skips here.
    expect(server?.hostname).toBe("127.0.0.1");
  });
});

describe("#563 — OPENCODE_AUTH + opencode_server_password compose plumbing", () => {
  // Raw text search rather than the parsed ComposeDoc type above (which does
  // not model `secrets:` blocks) — mirrors the style of the loopback-default
  // string checks elsewhere in this file.
  const coreRaw = readFileSync(join(STACK_DIR, "core.compose.yml"), "utf8");
  const coreDoc = yamlParse(coreRaw) as {
    services?: Record<string, { environment?: Record<string, unknown>; secrets?: unknown[] }>;
    secrets?: Record<string, { file?: string }>;
  };
  const portalsRaw = readFileSync(join(STACK_DIR, "portals.compose.yml"), "utf8");
  const portalsDoc = yamlParse(portalsRaw) as {
    services?: Record<string, { environment?: Record<string, unknown>; secrets?: unknown[] }>;
    secrets?: Record<string, { file?: string }>;
  };

  test("T28: assistant OPENCODE_AUTH is compose-interpolated with a false default", () => {
    const env = coreDoc.services?.assistant?.environment ?? {};
    expect(env.OPENCODE_AUTH).toBe("${OPENCODE_AUTH:-false}");
  });

  test("T29: assistant receives the OpenCode server password as a *_FILE secret, never raw", () => {
    const env = coreDoc.services?.assistant?.environment ?? {};
    expect(env.OPENCODE_SERVER_PASSWORD_FILE).toBe("/run/secrets/opencode_server_password");
    expect(env).not.toHaveProperty("OPENCODE_SERVER_PASSWORD");

    const secrets = (coreDoc.services?.assistant?.secrets ?? []) as string[];
    expect(secrets).toContain("opencode_server_password");

    // §G1: op_opencode_password is a delegated secret — private/secrets/, not
    // knowledge/secrets/ (bind-mounted wholesale into the assistant).
    expect(coreDoc.secrets?.opencode_server_password?.file).toBe(
      "${OP_HOME}/private/secrets/op_opencode_password",
    );
  });

  test("T30: guardian receives the same auth pair", () => {
    const env = portalsDoc.services?.guardian?.environment ?? {};
    expect(env.OPENCODE_AUTH).toBe("${OPENCODE_AUTH:-false}");
    expect(env.OPENCODE_SERVER_PASSWORD_FILE).toBe("/run/secrets/opencode_server_password");

    const secrets = (portalsDoc.services?.guardian?.secrets ?? []) as string[];
    expect(secrets).toContain("opencode_server_password");

    // Each managed compose file must stand alone for `docker compose config` —
    // the top-level secret declaration must exist in portals.compose.yml too,
    // not only in core.compose.yml.
    // §G1: op_opencode_password is a delegated secret — private/secrets/, not
    // knowledge/secrets/ (bind-mounted wholesale into the assistant).
    expect(portalsDoc.secrets?.opencode_server_password?.file).toBe(
      "${OP_HOME}/private/secrets/op_opencode_password",
    );
  });
});

describe("access toggles — the generated bind set matches compose reality (pin)", () => {
  test("assistant publishes the @openpalm/ui co-process port (loopback-first), not the removed OP_CLIENT_PORT", () => {
    const assistantPorts = allServices.assistant?.ports ?? [];
    // The removed @openpalm/client knob must stay gone ("One UI, delete the split").
    expect(assistantPorts.some((port) => String(port).includes("OP_CLIENT_PORT"))).toBe(false);
    // The UI co-process on the FIXED in-container port 3000, published from a
    // FLAT generated bind. The Compose fallback is the shipped UI port 3800.
    expect(assistantPorts).toContain(
      "${OP_UI_BIND_ADDRESS:-127.0.0.1}:${OP_UI_PORT:-3800}:3000",
    );
    // OP_UI_HOST_PORT existed only to assemble OpenCode's --cors origins.
    expect(core.services?.assistant?.environment?.OP_UI_HOST_PORT).toBeUndefined();
    expect(core.services?.assistant?.environment?.OP_PROJECT_NAME).toBe("${OP_PROJECT_NAME:-openpalm}");
  });

  test("ONE flat host port onto the guardian's OpenAI-compatible listener", () => {
    const guardianPorts = allServices.guardian?.ports ?? [];
    expect(guardianPorts).toContain("${OP_API_BIND_ADDRESS:-127.0.0.1}:${OP_API_PORT:-3821}:8182");
    // The duplicate chat host port onto the same :8182 listener is retired.
    expect(guardianPorts.filter((p) => String(p).endsWith(":8182"))).toHaveLength(1);
  });

  test("the guardian's own front door binds flat, and its admin listener is a literal", () => {
    const guardianPorts = allServices.guardian?.ports ?? [];
    expect(guardianPorts).toContain(
      "${OP_GUARDIAN_BIND_ADDRESS:-127.0.0.1}:${OP_GUARDIAN_PORT:-3830}:3830",
    );
    // Principal minting is never reachable off-box, under any toggle.
    expect(guardianPorts).toContain("127.0.0.1:${OP_GUARDIAN_ADMIN_PORT:-3831}:3831");
  });

  test("every voice variant publishes on a loopback LITERAL — voice is never exposed", () => {
    for (const name of ["voice", "voice-cuda", "voice-rocm"]) {
      const ports = allServices[name]?.ports ?? [];
      expect(ports).toContain(
        "127.0.0.1:${OP_VOICE_PORT_HOST:-8880}:8880",
      );
    }
  });
});

describe("#488 — host mDNS responder gate vars match compose reality (pin)", () => {
  // These pin the EXACT env vars the new host mDNS responder's gating logic
  // (resolveMdnsAdvertisements in mdns-responder.ts) keys on, so a future
  // rename of the compose bind-address vars can't silently decouple the
  // gate from what is actually published on the host network interface.

  test("guardian direct-listener host port defaults to loopback via OP_GUARDIAN_BIND_ADDRESS", () => {
    const guardianPorts = allServices.guardian?.ports ?? [];
    const hasGuardianDirectPort = guardianPorts.some(
      (p) => p === "${OP_GUARDIAN_BIND_ADDRESS:-127.0.0.1}:${OP_GUARDIAN_PORT:-3830}:3830",
    );
    expect(hasGuardianDirectPort).toBe(true);
  });

  test("assistant host port gates on OP_ASSISTANT_BIND_ADDRESS with loopback default", () => {
    const assistantPorts = allServices.assistant?.ports ?? [];
    // Fallback is the shipped OpenCode port 3810 (was the retired 3800).
    const hasAssistantPort = assistantPorts.some(
      (p) => p === "${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3810}:4096",
    );
    expect(hasAssistantPort).toBe(true);
  });
});
