# c14-smoke-hygiene: rootless smoke default-port collision + container leak (P3-3, P3-4)

_Severity: minor/test-infra (from PR #564 manual test notes)._

### 🟠 P3-3 `scripts/rootless-ownership-smoke.sh:108` — default assistant port collides across targets
`"${OP_ROOTLESS_SMOKE_ASSISTANT_PORT:-3896}"` uses the SAME default (3896) for both the `stack` and `portal-discord` targets, so starting both isolated projects concurrently fails on a Docker port bind. Every other port has a per-target default (`guardian_port_default` etc., lines 30-40). Fix: add a per-target `assistant_port_default` (e.g. 3896 for stack, 3996 for portal-discord) and use it at line 108, matching the existing per-target pattern.

### 🟠 P3-4 `scripts/rootless-ownership-smoke.sh:83-99` (`cleanup`) — successful portal smoke leaks containers
After a successful `portal-discord` run, cleanup left `${COMPOSE_PROJECT_NAME}-portal-guardian-1` and `${COMPOSE_PROJECT_NAME}-discord-1` running. The `dev_compose down` in cleanup does not tear down the guardian/discord/portal services brought up for that target (compose file/profile mismatch), violating the fixture's isolation/cleanup contract. Fix: tear down the whole compose project on cleanup (e.g. `docker compose --project-name "$COMPOSE_PROJECT_NAME" down --remove-orphans --volumes`, or include the same compose files+profiles used to bring the target up), so no container survives a successful or failed run.

## Verification gates
- `bash -n scripts/rootless-ownership-smoke.sh` (syntax)
- `bun run lint`
- Note: full behavior needs Docker (unavailable here); verify by inspection + shell syntax, and keep the per-target default/cleanup logic self-evidently correct.
