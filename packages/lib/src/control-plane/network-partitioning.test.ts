/**
 * D5a — Network Partitioning + mDNS Fixture Tests
 *
 * Parses the managed compose YAML files directly (no Docker required) and
 * asserts the security invariants described in docs/technical/network-partitioning-d5a.md.
 *
 * Invariants checked:
 * 1. assistant_net contains only authorised services (guardian + assistant + internal AI).
 * 2. No portal adapter (discord, slack, guardian-api) is on assistant_net.
 * 3. mDNS services follow the <name>-guardian.local / <name>.local naming convention.
 * 4. mDNS services are profile-gated (not always-on).
 * 5. The assistant host port defaults to loopback (127.0.0.1).
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

// Resolve the compose files relative to the repo root.
// __dirname = packages/lib/src/control-plane/
const REPO_ROOT = join(import.meta.dir, "../../../..");
const STACK_DIR = join(REPO_ROOT, ".openpalm/config/stack");

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
  const PORTAL_ADAPTERS = ["discord", "slack", "guardian-api"];

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
    const PORTAL_ADAPTERS_IN_STACK = ["discord", "slack", "guardian-api"];
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

describe("mDNS — naming convention and profile gating", () => {
  test("mdns-guardian service exists in core.compose.yml", () => {
    expect(core.services?.["mdns-guardian"]).toBeDefined();
  });

  test("mdns-assistant service exists in core.compose.yml", () => {
    expect(core.services?.["mdns-assistant"]).toBeDefined();
  });

  test("mdns-guardian is profile-gated (not always-on)", () => {
    const profiles = allServices["mdns-guardian"]?.profiles ?? [];
    expect(profiles.length).toBeGreaterThan(0);
  });

  test("mdns-assistant is profile-gated (not always-on)", () => {
    const profiles = allServices["mdns-assistant"]?.profiles ?? [];
    expect(profiles.length).toBeGreaterThan(0);
  });

  test("mdns-guardian profile is addon.mdns", () => {
    const profiles = allServices["mdns-guardian"]?.profiles ?? [];
    expect(profiles).toContain("addon.mdns");
  });

  test("mdns-assistant profile is addon.mdns.assistant", () => {
    const profiles = allServices["mdns-assistant"]?.profiles ?? [];
    expect(profiles).toContain("addon.mdns.assistant");
  });

  test("mdns-guardian command references <name>-guardian naming scheme", () => {
    const cmd = allServices["mdns-guardian"]?.command ?? "";
    // The command must include the -guardian suffix pattern.
    expect(cmd).toMatch(/-guardian/);
  });

  test("mdns-guardian and mdns-assistant are NOT on assistant_net", () => {
    // mDNS sidecars use network_mode:host, so they should not appear in assistant_net
    const onAssistantNet = servicesOnNetwork("assistant_net");
    expect(onAssistantNet).not.toContain("mdns-guardian");
    expect(onAssistantNet).not.toContain("mdns-assistant");
  });

  test("OP_ASSISTANT_NAME env knob is present on mdns-guardian", () => {
    const svc = core.services?.["mdns-guardian"];
    const env = svc?.environment;
    if (Array.isArray(env)) {
      expect(env.some((e: string) => e.startsWith("OP_ASSISTANT_NAME"))).toBe(true);
    } else if (env && typeof env === "object") {
      expect("OP_ASSISTANT_NAME" in env).toBe(true);
    } else {
      // environment block may use compose variable substitution in the command;
      // check the command string instead
      const cmd = allServices["mdns-guardian"]?.command ?? "";
      expect(cmd).toMatch(/OP_ASSISTANT_NAME/);
    }
  });
});
