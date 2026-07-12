# c11-assistant-auth-health: home-password stack cannot become healthy (P1-1, P1-2)

_Severity: BLOCKER (merge-blocking, from PR #564 manual test notes at PR-564-MANUAL-TEST-NOTES.md). Confirmed on 3825e005._

Root cause: OpenCode enables Basic auth whenever a non-empty `OPENCODE_SERVER_PASSWORD` is present, and the assistant healthcheck probes `/health` WITHOUT credentials → 401 → assistant `unhealthy` → guardian's `depends_on: assistant: condition: service_healthy` blocks the whole stack.

## Findings

### 🔴 P1-1 `packages/skeleton/system/stack/core.compose.yml:172` (assistant healthcheck)
The healthcheck test is `curl -sf http://localhost:4096/health || exit 1; ...` with no Basic credentials. Under the advertised `home-password` preset (`OPENCODE_AUTH=true` + a password secret), OpenCode returns 401 to the unauthenticated `/health` probe, so the assistant never reports healthy and the guardian (gated on `service_healthy`) cannot deploy — the feature's primary hardened-LAN path cannot start.

### 🔴 P1-2 `containers/assistant/entrypoint.sh:150-165` (`resolve_opencode_server_password`)
`resolve_opencode_server_password` reads the password file into `OPENCODE_SERVER_PASSWORD` whenever the file is non-empty, **unconditionally** — it does NOT gate on `opencode_auth_enabled`. So after switching from `home-password` to any non-password preset (`OPENCODE_AUTH=false`) the stale, still-non-empty secret is exported, OpenCode enables Basic auth from it, and `/health` stays protected while the healthcheck stays unauthenticated → the stack remains unhealthy until the operator manually empties the secret.

## Fix direction (decide + justify in the spec)
Make auth-enablement, password export, and the healthcheck probe mutually consistent:
1. **entrypoint.sh:** only read/export `OPENCODE_SERVER_PASSWORD` from the file when `opencode_auth_enabled` (a stale non-empty secret with `OPENCODE_AUTH=false` must be ignored, not exported). Keep the existing fail-fast when auth IS enabled but no password resolves.
2. **core.compose.yml healthcheck:** when `OPENCODE_AUTH` is truthy, authenticate the `/health` probe — e.g. read the mounted secret file and pass `curl -u "${OPENCODE_SERVER_USERNAME:-opencode}:$(cat /run/secrets/opencode_server_password)"`; when auth is off, probe plain as today. `OPENCODE_AUTH` is available to the healthcheck (compose `environment:` sets `OPENCODE_AUTH: ${OPENCODE_AUTH:-false}`); the secret is mounted at `/run/secrets/opencode_server_password`. Preserve the existing `$${OP_CLIENT_PORT:-3000}` compose-escaped client probe and its skip-file behavior.
Coordinate the username default (`opencode`) with clusters c1/c2.

## Verification gates
- `bun run lint`
- `cd packages/guardian && bun test --no-orphans` (if any guardian assertion touches upstream auth)
- Static checks: a test asserting the entrypoint gates the export on auth, and that the compose healthcheck authenticates when OPENCODE_AUTH is truthy (grep/parse the compose + a bash-level unit test of resolve_opencode_server_password if the repo has an entrypoint test harness — otherwise assert on the rendered compose). Note that full end-to-end health can only be verified with Docker (unavailable here); state that limitation.
