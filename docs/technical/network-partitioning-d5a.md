# D5a — Network Partitioning Verification + mDNS (0.12.0)

**Issue:** #436 Part 2 — secure partitioning verification + mDNS
**Disposition:** NO DEFECT found. mDNS is now published by OpenCode's native
in-process responder (default-off, LAN-first). The avahi `apk add` sidecars have
been removed.

---

## Network Partitioning Audit

Audited `.openpalm/config/stack/{core,services,portals}.compose.yml` as of 2026-06-13.

### Networks defined

| Network | Purpose |
|---------|---------|
| `assistant_net` | Internal backbone: assistant ↔ guardian ↔ internal AI services |
| `portal_net` | External portal ingress: guardian ↔ portal adapters |

### `assistant_net` membership

| Service | File | Justification |
|---------|------|---------------|
| `assistant` | core.compose.yml | The runtime being protected |
| `guardian` | portals.compose.yml | The sole authorized ingress broker |
| `ollama` / `ollama-cuda` / `ollama-rocm` | services.compose.yml | Internal AI inference (assistant calls these; no portal_net membership) |
| `voice` / `voice-cuda` / `voice-rocm` | services.compose.yml | Internal TTS/STT (assistant calls these; no portal_net membership) |

### Finding: NO DEFECT

The topology is correctly partitioned:

- **Portal adapters** (`discord`, `slack`, `guardian-api`) are on `portal_net` only. They cannot reach the assistant container — traffic must go through the guardian.
- **Ollama and voice services** are on `assistant_net` only. They are internal AI infrastructure with no `portal_net` membership and no externally-reachable ports (all host bindings use loopback via `OP_BIND_ADDRESS`/`OP_VOICE_BIND_ADDRESS` nested defaults).
- **The guardian** is the only service on both networks, acting as the sole authorized broker.
- **The assistant** host port defaults to `127.0.0.1` (loopback-only). Direct host access requires an explicit `OP_ASSISTANT_BIND_ADDRESS` change by the operator.

The `ollama`/`voice` presence on `assistant_net` is intentional and correct: they serve the assistant container directly and have no path to external clients.

---

## mDNS Implementation (native OpenCode responder)

**Status:** Shipped via OpenCode's built-in mDNS responder. Default **OFF**
(LAN-first). The previous avahi `apk add` sidecars (`mdns-guardian`,
`mdns-assistant`) have been **removed** — they used the boot-install
anti-pattern and `network_mode: host`, and bridge-network multicast never
reached the LAN anyway.

### How native OpenCode mDNS works

OpenCode publishes its own `.local` record in-process when `server.mdns: true`
**and** the server hostname is not loopback. The publish call advertises:

| Field | Value |
|-------|-------|
| Service type | `_http._tcp.local` (fixed) |
| Instance label | `opencode-<port>` (e.g. `opencode-4096`) — **HARDCODED, not configurable** |
| SRV / A host target | `server.mdnsDomain` (the resolvable `.local` name), default `opencode.local` |
| Port | `server.port` |
| TXT | `{path:"/"}` |

The responder binds every non-internal host interface address it enumerates.
There is a hard loopback gate: if `hostname` is `127.0.0.1` / `localhost` /
`::1`, publish is skipped with `"mDNS enabled but hostname is loopback;
skipping mDNS publish"`.

### Configuration

mDNS is configured directly in the OpenCode config files (file-assembly — the
whole file is written; `mdnsDomain` cannot be templated by OpenCode itself, so
install/upgrade writes the operator's chosen `.local` name):

| Config file | hostname | mdns | mdnsDomain | Behaviour |
|-------------|----------|------|------------|-----------|
| `.openpalm/config/assistant/opencode.jsonc` | `0.0.0.0` | `false` (ship default) | `openpalm.local` | Passes the loopback gate; flip `mdns:true` to advertise host `openpalm.local` |
| `.openpalm/config/guardian/opencode.jsonc` | `127.0.0.1` | `false` | — | Loopback-internal moderator; never advertises (would self-skip even if on) |

### Achievable names — and the gap

- The resolvable `.local` **HOSTNAME** is fully configurable via `mdnsDomain`,
  so the assistant can advertise `openpalm.local` (or any `<name>.local`).
- **GAP:** the Bonjour service **instance label** is hardcoded `opencode-<port>`
  (e.g. `opencode-4096`). A device doing a `_http._tcp.local` discovery sweep
  sees an instance literally named `opencode-4096`, not a friendly
  `openpalm-assistant`. Only the resolved hostname carries the custom name.
  This is a regression from the avahi sidecars, which set both the service
  label and the hostname. There is no OpenCode config to change it.
- **GUARDIAN:** native OpenCode mDNS **cannot** advertise
  `<name>-guardian.local`. The guardian's moderation OpenCode is loopback-bound
  by design (security invariant: only reached inside the guardian container),
  and the loopback gate means it never publishes. The LAN-facing
  `<name>-guardian.local` name belongs to the guardian's **HTTP front door**
  (the Bun server terminating portal `/oc/*` ingress), which must be advertised
  by the host OS / the operator's LAN setup — not by an OpenCode process.

### LAN reachability caveats

1. **Bridge network does not reach the LAN.** Native mDNS publishes from inside
   the container's network namespace. On the default Docker bridge, the
   multicast (UDP 5353 / 224.0.0.251) stays inside the bridge and does not reach
   the physical LAN segment. Published unicast TCP ports do not help — multicast
   is not forwarded.
2. **Linux host win requires `network_mode: host`.** To actually reach the LAN
   on a Linux host, the assistant container must run with `network_mode: host`
   so the responder binds the real LAN interface. This is LAN-gated and only
   appropriate once LAN exposure is intentional.
3. **macOS is inert.** On Docker Desktop / OrbStack, `network_mode: host` is the
   Linux VM, not the Mac's LAN, so native container mDNS does not advertise on
   the Mac LAN. macOS LAN advertisement must come from the host OS.
4. **LAN-first default.** Both config files ship `mdns: false`. Even left on,
   the guardian self-skips (loopback) and the assistant only publishes once its
   server binds a non-loopback, LAN-reachable interface.

### Enabling (assistant, Linux host)

1. Edit `.openpalm/config/assistant/opencode.jsonc`: set `"mdns": true` and
   `"mdnsDomain": "<name>.local"`.
2. Ensure the assistant container reaches the LAN (e.g. `network_mode: host`
   via a `custom.compose.yml` overlay) — bridge mode keeps mDNS container-local.
3. Restart the assistant container (OpenCode caches config at startup).

---

## Test Coverage

`packages/lib/src/control-plane/network-partitioning.test.ts` — pure YAML/JSONC
parsing, no Docker required:
- Asserts `assistant_net` contains only the expected services (guardian + assistant + internal AI services).
- Asserts no portal adapter service is on `assistant_net`.
- Asserts the avahi `mdns-guardian` / `mdns-assistant` sidecars are removed and no service does `apk add avahi`.
- Asserts the assistant ships `mdns: false` with a `.local` `mdnsDomain`, and the guardian moderator keeps `mdns: false` while staying loopback-bound.
