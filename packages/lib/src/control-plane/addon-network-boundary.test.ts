import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';

// S.6b — addon-network trust boundary.
//
// Third-party addon images must not sit inside the assistant's trust network with
// credential-free reach to the OpenCode API (:4096). The structural fix is a dedicated
// `addon_net`: addons that do NOT need to talk to the assistant live there, off the
// `assistant_net` segment the guardian uses to reach the assistant.
//
// Sweep of services.compose.yml (verified against source, 2026-07-05):
//   - voice{,-cuda,-rocm}: consumed by the UI host process over the published loopback
//     port 127.0.0.1:8880 (packages/ui/src/lib/server/voice/bring-up.ts voiceHostPort,
//     packages/ui/src/routes/voice/[...path]/+server.ts). There is NO in-container path from the
//     assistant to voice or from voice back to the assistant (containers/voice has no :4096
//     / OpenCode callback). => voice needs NO assistant reachability and is fully segmented
//     onto addon_net. (This REVERSES the plan's tentative guess that voice was the exception.)
//   - ollama{,-cuda,-rocm}: the assistant reaches it as its LLM provider over the Docker DNS
//     name `ollama:11434` (packages/lib/src/provider-constants.ts OLLAMA_INSTACK_URL,
//     packages/ui/src/lib/setup/setup-state.svelte.ts). The assistant->ollama inference path
//     requires shared-network reachability, and Docker bridge networks are bidirectional, so
//     ollama genuinely needs assistant reachability and is the per-service exception that
//     stays on assistant_net.
//
// Topology-only invariant: a live cross-container reachability probe needs a running stack,
// which is unavailable here. These assertions encode the boundary at the compose-topology
// level; true assistant-API isolation from a co-resident ollama additionally requires D3(a)
// (re-enabling upstream OpenCode auth), the documented follow-up.

const REPO_ROOT = join(import.meta.dir, '../../../..');
const STACK_DIR = join(REPO_ROOT, 'packages/skeleton/system/stack');

type ComposeService = { networks?: unknown };
type ComposeFile = {
  services?: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
};

function loadCompose(name: string): ComposeFile {
  return yamlParse(readFileSync(join(STACK_DIR, name), 'utf8')) as ComposeFile;
}

// Normalize both compose network forms — the list form `[a, b]` and the map form
// `{a: {aliases: [...]}}` — into a plain array of network names.
function serviceNetworks(networks: unknown): string[] {
  if (Array.isArray(networks)) return networks.filter((n): n is string => typeof n === 'string');
  if (networks && typeof networks === 'object') return Object.keys(networks as Record<string, unknown>);
  return [];
}

const core = loadCompose('core.compose.yml');
const services = loadCompose('services.compose.yml');
const portals = loadCompose('portals.compose.yml');

// Networks are declared once, in core.compose.yml, and shared across the merged stack
// (services.compose.yml already references assistant_net without redeclaring it).
const declaredNetworks = new Set(Object.keys(core.networks ?? {}));

const ADDON_SERVICES = ['ollama', 'ollama-cuda', 'ollama-rocm', 'voice', 'voice-cuda', 'voice-rocm'];
const VOICE_SERVICES = ['voice', 'voice-cuda', 'voice-rocm'];
const OLLAMA_SERVICES = ['ollama', 'ollama-cuda', 'ollama-rocm'];

describe('S.6b addon-network trust boundary', () => {
  test('addon_net is declared in the merged stack networks', () => {
    expect(declaredNetworks.has('addon_net')).toBe(true);
  });

  test('the guardian still reaches the assistant over assistant_net', () => {
    const guardianNets = serviceNetworks(portals.services?.guardian?.networks);
    expect(guardianNets).toContain('assistant_net');
  });

  test('the assistant serves its API on assistant_net (the guarded segment)', () => {
    const assistantNets = serviceNetworks(core.services?.assistant?.networks);
    expect(assistantNets).toContain('assistant_net');
    // The assistant must NOT join addon_net: doing so would re-expose :4096 to every
    // segmented addon (including voice) over that bridge.
    expect(assistantNets).not.toContain('addon_net');
  });

  test('voice services are segmented onto addon_net, off the assistant trust network', () => {
    for (const name of VOICE_SERVICES) {
      const nets = serviceNetworks(services.services?.[name]?.networks);
      expect(nets).toContain('addon_net');
      expect(nets).not.toContain('assistant_net');
    }
  });

  test('ollama services are the documented per-service exception: on assistant_net (assistant inference)', () => {
    for (const name of OLLAMA_SERVICES) {
      const nets = serviceNetworks(services.services?.[name]?.networks);
      expect(nets).toContain('assistant_net');
    }
  });

  // Upgrade-path safety: an already-enabled addon must still resolve after the migration.
  // Every network any addon references must be defined in the merged stack, or
  // `docker compose up` would fail for a previously-working enabled addon.
  test('upgrade path: every network referenced by an addon service is defined', () => {
    for (const name of ADDON_SERVICES) {
      for (const net of serviceNetworks(services.services?.[name]?.networks)) {
        expect(declaredNetworks.has(net)).toBe(true);
      }
    }
  });
});
