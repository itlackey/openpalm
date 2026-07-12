# c9-lifecycle-guard: lifecycle: channel_lan deprecation guard must only block activate (install/upgrade)

_Severity: major. PR #564 review (fwdslsh-dev, 2026-07-12)._

## Findings

### 🟠 `packages/lib/src/control-plane/lifecycle.ts:249` (r3566892768)

The channel_lan overlay-deprecation guard throws for every op kind → a stale overlay blocks uninstall and update, not just install/upgrade. checkCustomComposeChannelLan runs unconditionally at the top of reconcileStack (before the activate/deactivate branch), so its blockError throw fires for op.kind==='uninstall' and 'update' too. An operator with a leftover config/stack/custom.compose.yml referencing the removed channel_lan network cannot tear the stack down (openpalm uninstall) or update it — both throw and refuse to run. The guard's rationale (prevent applyHome overwriting managed compose then failing) is an activation concern. Fix: gate the guard on activate (install/upgrade) — uninstall/update should not be blocked by a deprecated overlay reference.

## Verification gates

- `bun run lib:test`
