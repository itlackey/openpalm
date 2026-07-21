# D5a — Network Partitioning Verification + mDNS (0.12.0 / 0.13.0)

**Issue:** #436 Part 2 — secure partitioning verification + mDNS; #488 —
Guardian/assistant LAN mDNS self-advertisement.
**Disposition:** NO DEFECT found. mDNS is now published primarily by a HOST
control-plane responder (#488, default-off/gated, LAN-first), with OpenCode's
native in-process responder kept as a manual/advanced fallback. The avahi
`apk add` sidecars have been removed.

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

## mDNS Implementation

### D1 — Advertisement locus: the HOST control-plane process (#488)

**Ratified.** The #488 issue text says "the guardian … advertise[s]", but that
literal reading is explicitly **rejected**: mDNS self-advertisement runs as a
`multicast-dns` responder inside the long-lived **host UI server
process** (`packages/lib/src/control-plane/mdns-responder.ts`, started by
`hooks.server.ts`'s one-shot init — every supervisor, `openpalm ui serve`,
`openpalm`, Electron, spawns this process, so there is a single start locus
and the CLI needs no separate wiring), **not** the guardian container. Two
reasons rule out an in-guardian responder:

1. **Bridge multicast never reaches the LAN** (see the reachability caveats
   below) — running the responder inside the guardian's container network
   namespace would have exactly the same dead-end as the native-OpenCode
   in-container approach documented below.
2. **`network_mode: host` would break the partitioning invariants this doc
   audits.** The guardian is the sole authorized dual-network broker between
   `assistant_net` and `portal_net` (§ Network Partitioning Audit above);
   putting it on the host network namespace defeats that isolation, and is
   inert on macOS anyway (Docker Desktop/OrbStack `network_mode: host` is the
   Linux VM, not the Mac's LAN).

The `packages/guardian` package is untouched by #488 — the guardian container
image, its runtime, and its network membership are unchanged.

### How the host responder works

Pure encode/decode/gating (`sanitizeDnsLabel`, `deriveMdnsNames`,
`resolveMdnsAdvertisements`, `resolveMdnsStatus`, `parseDnsQuestions`,
`buildMdnsAnswer`/`buildMdnsAnnouncement`/`buildMdnsGoodbye`) is unit-tested
without sockets; a thin `node:dgram` socket layer (injectable factory for
tests) binds UDP `5353`, joins multicast group `224.0.0.251` with
`reuseAddr: true` (coexists with an already-running avahi/Bonjour), and
answers `A`/`ANY`/`PTR` queries for the advertised names. `udp4` + A records
only — no IPv6/AAAA, no RFC 6762 §8 probing/conflict defense (we are the only
intended publisher of these names).

**Gating (bind-address-only, D6):**

| Name | Gate | Host port |
|---|---|---|
| `<base>-guardian.local` | `OP_BIND_ADDRESS` set and non-loopback | `OP_GUARDIAN_PORT` (default 3830) |
| `<base>.local` | `OP_ASSISTANT_BIND_ADDRESS` set and non-loopback (no `OP_BIND_ADDRESS` fallback — mirrors `core.compose.yml`'s assistant port line) | `OP_ASSISTANT_PORT` (default 3810) |

The gate does **not** check whether a guardian-ingress addon is actually
enabled (the guardian is profile-gated) — checking addon/profile state would
couple the responder to compose state parsing for a purely cosmetic gain (a
name that resolves to a closed port). The loopback default (both vars unset)
starts **no socket at all** — the fail-closed guarantee is enforced before
the socket factory is even consulted.

**Name derivation (D2):** `<base>` = `sanitizeDnsLabel(OP_PROJECT_NAME ??
"openpalm")` — there is no structured "assistant name" (persona is free-text
markdown), so `OP_PROJECT_NAME` is the source and the admin-UI hint text
names it explicitly so operators aren't surprised their persona name isn't
used.

**`OP_MDNS` off-switch (D5):** a single opt-out knob (`OP_MDNS=0|false|off|no`,
non-secret, `stack.env`) disables the responder even when binds are
non-loopback — the real operator need is coexistence with an
already-configured host responder (avahi/Bonjour) publishing conflicting
records. Default (unset) = enabled, still fully gated by the bind addresses,
so the default security posture is unchanged.

**Displayed scheme (D4, #557 coordination):** the admin UI renders `http://`
for now. The GET/PUT `/api/host/stack` payload carries `{ name, port,
advertised }` (not a pre-baked URL string), so once #557 (guardian edge TLS)
lands the UI can switch the rendered scheme to HTTPS without an API change.

**Lifecycle limitation:** advertisement lives and dies with the host
`openpalm` UI process — if that process isn't running (stack up, UI down),
the names don't resolve even though the stack does. This is documented
rather than solved with a longer-lived host component (systemd/launchd unit)
— that would require new host-OS infrastructure outside the control plane.
The responder's socket is always `unref`'d, so it never *prolongs* the host
process either.

### Native OpenCode mDNS (manual/advanced path, D3)

The native in-container responder documented below **remains unchanged**
(`"mdns": false, "mdnsDomain": "openpalm.local"` in the assistant/guardian
`opencode.jsonc`) and is **not** file-assembled to the derived host-responder
name — the host responder is the primary (and only LAN-reachable)
advertisement mechanism, and the native path is inert on bridge networks
regardless (and entirely inert on macOS). #563 (network access presets)
**ratified this as final, not a placeholder**: presets drive the HOST
responder exclusively, by writing bind vars (`OP_ASSISTANT_BIND_ADDRESS` /
`OP_BIND_ADDRESS`) to `stack.env` — there is no per-preset `opencode.jsonc`
file-assembly step and none is planned. `network-preset.ts` exposes
`assistantMdns`/`guardianMdns` intent flags whose equivalence to
`resolveMdnsStatus()` (this responder) is pinned by test, so the two
mechanisms can never silently diverge. Only the comment blocks in
`core.compose.yml` and `opencode.jsonc` were updated to point at the host
responder as primary; the native `"mdns": false` block stays the permanent
manual/advanced path for operators who bind-mount their own `opencode.jsonc`.

**Preset → mDNS mapping (#563):**

| Preset | `<name>.local` (assistant) | `<name>-guardian.local` (guardian) |
|---|---|---|
| This PC only | off | off |
| Home network, with password | **on** | off |
| Home network, open access | **on** | off |
| Shared network, guardian protected | off | **on** |

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

### Achievable names — and the gap (native path only)

These limitations apply to the **native OpenCode** path documented in this
section; the host responder (#488, above) does not have them — it advertises
friendly `_http._tcp` instance labels itself and can advertise the guardian
name directly, since it runs outside any one service's container.

- The resolvable `.local` **HOSTNAME** is fully configurable via `mdnsDomain`,
  so the assistant can advertise `openpalm.local` (or any `<name>.local`).
- **GAP (native path only):** the Bonjour service **instance label** is
  hardcoded `opencode-<port>` (e.g. `opencode-4096`). A device doing a
  `_http._tcp.local` discovery sweep sees an instance literally named
  `opencode-4096`, not a friendly `openpalm-assistant`. Only the resolved
  hostname carries the custom name. There is no OpenCode config to change it.
  This gap now only shows up if the manual native path is used instead of (or
  alongside) the host responder, which advertises a friendly
  `<base>._http._tcp.local` instance label.
- **GUARDIAN (native path only):** native OpenCode mDNS **cannot** advertise
  `<name>-guardian.local`. The guardian's moderation OpenCode is loopback-bound
  by design (security invariant: only reached inside the guardian container),
  and the loopback gate means it never publishes. The LAN-facing
  `<name>-guardian.local` name is exactly what the #488 host responder exists
  to fill — it advertises the guardian's **HTTP front door** (the Bun server
  terminating portal `/oc/*` ingress) from outside any container, gated by
  `OP_BIND_ADDRESS`.

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
- Pins the exact `OP_BIND_ADDRESS` (guardian) / `OP_ASSISTANT_BIND_ADDRESS` (assistant) compose port strings the host responder's gating logic keys on, so a future rename can't silently decouple the gate from compose reality.

`packages/lib/src/control-plane/mdns-responder.test.ts` — the host responder
(#488): name derivation, the bind-address gating truth table, hand-rolled
DNS wire-format encode/decode fixtures (no real sockets), stub-socket
responder lifecycle, and stack.env reconcile behavior.
