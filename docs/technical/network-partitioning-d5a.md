# D5a — Network Partitioning Verification + mDNS (0.12.0)

**Issue:** #436 Part 2 — secure partitioning verification + mDNS
**Disposition:** NO DEFECT found. mDNS scaffolded (default-off, daemon wiring needs review).

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

**Status:** Scaffolded (compose profiles + env knobs). Daemon wiring needs review before enabling in production.

### Design

Two profile-gated sidecars added to `core.compose.yml`:

| Service | Profile | Advertises |
|---------|---------|-----------|
| `mdns-guardian` | `addon.mdns` | `<OP_ASSISTANT_NAME>-guardian.local` |
| `mdns-assistant` | `addon.mdns.assistant` | `<OP_ASSISTANT_NAME>.local` |

### Env knobs

| Variable | Default | Purpose |
|----------|---------|---------|
| `OP_ASSISTANT_NAME` | `openpalm` | Base name used in mDNS hostnames |
| `OP_MDNS_ENABLED` | (use profiles) | Gate — enable `addon.mdns` in `OP_ENABLED_ADDONS` |

### Naming scheme

- Guardian LAN exposure: `${OP_ASSISTANT_NAME}-guardian.local` (e.g. `openpalm-guardian.local`)
- Assistant LAN access: `${OP_ASSISTANT_NAME}.local` (e.g. `openpalm.local`)

### Caveats / daemon wiring review needed

1. **Linux only.** On macOS (OrbStack / Docker Desktop) mDNS is handled by the host OS; the avahi sidecar has no effect and should not be enabled.
2. **`network_mode: host` required.** avahi must see the real LAN interface. This means the container shares the host network namespace — it is not isolated. Only enable when LAN exposure is intentional.
3. **dbus startup ordering.** The command override starts `dbus-daemon` then `avahi-daemon` then `avahi-publish`. This works on most Linux distros but may need adjustment if the host dbus socket is not available in the container.
4. **Not gated on `OP_BIND_ADDRESS` automatically.** The operator must ensure LAN exposure is also enabled (i.e. `OP_BIND_ADDRESS=0.0.0.0` or a LAN IP) before enabling `addon.mdns`. Enabling mDNS while the port is loopback-only is harmless but misleading.
5. **avahi-publish exits** when its record is withdrawn. The `wait` command in the entrypoint ensures the container does not exit, but a more robust approach (avahi `.service` XML file) should be adopted before this is declared production-ready.

### Enabling

```bash
# In knowledge/env/stack.env:
OP_ASSISTANT_NAME=myassistant        # optional, defaults to openpalm
OP_ENABLED_ADDONS=...,addon.mdns     # enables mdns-guardian
# OP_ENABLED_ADDONS=...,addon.mdns.assistant  # also advertise assistant.local
```

---

## Test Coverage

`packages/lib/src/control-plane/network-partitioning.test.ts` — pure YAML parsing, no Docker required:
- Asserts `assistant_net` contains only the expected services (guardian + assistant + internal AI services).
- Asserts no portal adapter service is on `assistant_net`.
- Asserts mDNS service names follow `<name>-guardian.local` / `<name>.local` convention.
- Asserts mDNS services are profile-gated (not always-on).
