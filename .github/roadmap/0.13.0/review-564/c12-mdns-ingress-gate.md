# c12-mdns-ingress-gate: shared-guardian mDNS advertises an unusable (404) listener (P2-1)

_Severity: BLOCKER (from PR #564 manual test notes). Confirmed on 3825e005._

## Finding

### 🔴 P2-1 `packages/lib/src/control-plane/mdns-responder.ts:107-118` (`isGuardianGated`)
`isGuardianGated` advertises the guardian `.local` name/port (3830) whenever `OP_BIND_ADDRESS` is LAN-visible, WITHOUT considering `GUARDIAN_DIRECT_INGRESS`. The `shared-guardian` preset leaves direct ingress OFF, so the advertised `openpalm-guardian.local:3830` listener returns 404 for `/` and `/oc/session` — the UI reports a guardian advertised on the LAN that cannot actually serve requests.

## Fix direction (conservative — no posture change)
Gate the guardian mDNS advertisement on `GUARDIAN_DIRECT_INGRESS` being enabled: `isGuardianGated` returns false when direct ingress is disabled, so an un-served direct listener is never advertised. Find the exact env var name + truthy representation the guardian uses for `GUARDIAN_DIRECT_INGRESS` (packages/guardian/src/config.ts / server.ts) and mirror that parse in the responder. Extend `resolveMdnsStatus`/`isGuardianGated` tests to pin: LAN bind + ingress off → not advertised; LAN bind + ingress on → advertised. Do NOT change any default posture (do not auto-enable an ingress here).

NOTE for the summary (do not implement without sign-off): making the shared-guardian preset's front-door + pairing story actually usable likely also wants `GUARDIAN_DIRECT_INGRESS` enabled under that preset — but that OPENS an ingress and is a posture decision for the user, out of scope for this conservative bug-fix cluster.

## Verification gates
- `bun run lint`
- `bun run lib:test`
