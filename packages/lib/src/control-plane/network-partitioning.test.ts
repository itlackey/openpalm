/**
 * D5a — Network Partitioning + mDNS Fixture Tests
 *
 * Parses the managed compose YAML files directly (no Docker required) and
 * asserts the security invariants described in docs/technical/network-partitioning-d5a.md.
 *
 * Invariants checked:
 * 1. assistant_net contains only authorised services (guardian + assistant + internal AI).
 * 2. No portal adapter (discord, slack, guardian-api) is on assistant_net.
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
  ]);

  // Portal adapters — these must NEVER be on assistant_net.
  const PORTAL_ADAPTERS = ["discord", "slack"];

  test("assistant is on assistant_net", () => {
    expect(allServices["assistant"]?.networks).toContain("assistant_net");
  });

  test("guardian is on assistant_net", () => {
    expect(allServices["guardian"]?.networks).toContain("assistant_net");
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
    expect(allServices["guardian"]?.networks).toContain("portal_net");
  });
});

describe("network partitioning — assistant host port defaults", () => {
  test("assistant host port defaults to loopback (127.0.0.1)", () => {
    const assistantPorts = allServices["assistant"]?.ports ?? [];
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

  const assistantConfig = loadJsonc("packages/skeleton/config/assistant/opencode.jsonc");
  const guardianConfig = loadJsonc("packages/skeleton/config/guardian/opencode.jsonc");

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
