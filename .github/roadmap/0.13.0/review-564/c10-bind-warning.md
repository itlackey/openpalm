# c10-bind-warning: bind-warning: 'guardian protected' framing only when guardian ingress enabled

_Severity: minor. PR #564 review (fwdslsh-dev, 2026-07-12)._

## Findings

### 🟡 `packages/lib/src/control-plane/bind-warning.ts:74` (r3566893095)

The OP_BIND_ADDRESS warning asserts 'guardian protected' unconditionally → false security assurance when no guardian ingress is enabled. This pushes the static PRESET_FRAMING.OP_BIND_ADDRESS='Shared network, guardian protected' wording for any non-loopback OP_BIND_ADDRESS. collectBindAddressWarnings takes only env — no guardian-addon parameter, no guardian-enablement check. In a drifted env (hand-set OP_BIND_ADDRESS=0.0.0.0 with no guardian-ingress addon enabled), the cascade nests into OP_CLIENT_*/OP_VOICE_* and exposes those raw services on the LAN with no guardian proxy — yet the log says 'guardian protected'. Fix: only use the 'guardian protected' framing when a guardian-ingress addon is actually enabled; otherwise warn that the services are exposed unprotected.

## Verification gates

- `bun run lib:test`
