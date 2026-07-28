# Network Partitioning And mDNS

This document records the current managed topology. The authoritative inputs
are `packages/skeleton/system/stack/*.compose.yml`; tests in
`packages/lib/src/control-plane/network-partitioning.test.ts` prevent drift.

## Docker Networks

| Network | Members | Purpose |
|---|---|---|
| `assistant_net` | Assistant, Guardian when enabled, Ollama variants | Protected assistant/provider path |
| `portal_net` | Guardian and Discord/Slack adapters | External protocol ingress |
| `addon_net` | Voice variants and addons needing no assistant access | Segmented optional services |

Guardian is the only managed service bridging `portal_net` and
`assistant_net`. Portal adapters cannot address the assistant directly. Voice
does not join `assistant_net`; the host UI reaches it through its loopback host
publication and same-origin `/voice/*` pass-through.

## Host Publications

- UI: `${OP_UI_BIND_ADDRESS:-127.0.0.1}:${OP_UI_PORT:-3800}`
- Assistant OpenCode: `${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3810}`
- Guardian direct listener: `${OP_GUARDIAN_BIND_ADDRESS:-127.0.0.1}:${OP_GUARDIAN_PORT:-3830}`
- Guardian admin: literal `127.0.0.1:${OP_GUARDIAN_ADMIN_PORT:-3831}`
- Compatible API: `${OP_API_BIND_ADDRESS:-127.0.0.1}:${OP_API_PORT:-3821}`
- Voice: literal `127.0.0.1:${OP_VOICE_PORT_HOST:-8880}`

There is no global bind cascade. Voice and Guardian admin intentionally have no
bind-address variable. Guardian's internal `8080` gateway is not host-published.

## Guardian Deployment

Guardian is profile-gated and runs only when a Guardian-ingress addon is enabled:
`chat`, `api`, `discord`, `slack`, or `gateway`. This does not make it a core
service; the assistant is the only always-on core container.

## Host mDNS

The primary LAN-reachable mDNS responder runs in the host UI process, not in a
container. Container bridge multicast does not reach the physical LAN, and
putting Guardian on the host network would defeat the partitioning above.

The host responder:

- opens no socket while all relevant binds are loopback
- advertises `<project>.local` when the UI bind is non-loopback, falling back to
  the direct-assistant bind for headless direct access
- advertises `<project>-guardian.local` only when the Guardian bind is
  non-loopback and `GUARDIAN_DIRECT_INGRESS=true`
- derives `<project>` from the sanitized `OP_PROJECT_NAME`
- is disabled by explicit `OP_MDNS=0`, `false`, `no`, or `off`
- lives only as long as the host UI process

The managed assistant and Guardian OpenCode configs keep native OpenCode mDNS
off. Operators may experiment with it in user config, but bridge-network native
mDNS is not OpenPalm's LAN discovery path.

## Verification

Static verification:

```bash
bun test packages/lib/src/control-plane/network-partitioning.test.ts
bun test packages/lib/src/control-plane/mdns-responder.test.ts
```

Resolved Compose verification requires a seeded `OP_HOME` because file-backed
secrets are part of the assembly. Use `scripts/dev-e2e-test.sh` or the rootless
smoke fixtures rather than inventing a reduced topology.
