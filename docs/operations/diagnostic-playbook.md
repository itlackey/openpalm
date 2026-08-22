# Diagnostic Playbook

Use this workflow to isolate a browser, host API, OpenCode, or Compose failure
without mixing route namespaces or runtimes.

## Start the Correct UI Process

The assistant-served UI at port `3800` is intentionally non-admin. Start the
loopback-only host admin process for `/api/host/*` diagnostics:

```bash
openpalm admin --no-open
```

The host page is <http://127.0.0.1:3880/host>.

## Authenticate

UI authentication uses an `op_session` cookie. Log in through
`/api/auth/login`, then reuse the cookie jar:

```bash
password="$(< "${OP_HOME:-$HOME/.openpalm}/state/secrets/op_ui_login_password")"
jq -nc --arg password "$password" '{password: $password}' \
  | curl -sS -c cookies.txt -X POST http://127.0.0.1:3880/api/auth/login \
      -H 'content-type: application/json' \
      --data-binary @-
```

The cookie is `HttpOnly` and `SameSite=Lax`. `/admin/*` is not an alias and
intentionally returns `404`.

Guardian's `http://127.0.0.1:3831/admin/principals` is a separate server. It
remains valid and uses the bearer token from
`state/secrets/op_guardian_admin_token`, not the UI session cookie.

## Route Map

| Namespace | Scope |
|---|---|
| `/api/auth/*` | Login, logout, and session |
| `/api/host/*` | Host control plane; available only in an admin-capable host process |
| `/api/assistant/*` | Assistant-owned model, persona, and AKM settings |
| `/oc/*` | Same-origin proxy to the configured OpenCode runtime |

Useful host endpoints include:

- `GET /api/host/health`
- `GET /api/host/providers`
- `GET /api/host/providers/host-status`
- `GET /api/host/logs?service=assistant&tail=200`
- `GET /api/host/config/validate`
- `GET /api/host/containers/list`
- `GET /api/host/containers/events?since=1h`
- `GET /api/host/containers/stats`

## Provider Triage

The provider-display path is:

```text
browser component
  -> GET /api/host/providers
  -> host route
  -> OpenCode GET /provider
  -> OpenCode GET /provider/auth
```

Check one layer at a time:

```bash
# Public UI-server health
curl -sS http://127.0.0.1:3880/health

# Authenticated host routes
curl -sS -b cookies.txt http://127.0.0.1:3880/api/host/providers/host-status | jq
curl -sS -b cookies.txt http://127.0.0.1:3880/api/host/providers | jq

# OpenCode directly
curl -sS http://127.0.0.1:3810/health | jq
curl -sS http://127.0.0.1:3810/provider | jq
curl -sS http://127.0.0.1:3810/provider/auth | jq
```

If direct OpenCode is protected because `access.assistantDirect` is enabled,
use its generated Basic credential or inspect through the same-origin `/oc`
proxy instead of treating `401` as a dead process.

Relevant source paths:

- `packages/ui/src/lib/components/providers/ConnectSheet.svelte`
- `packages/ui/src/lib/components/providers/ProvidersPanel.svelte`
- `packages/ui/src/routes/api/host/providers/+server.ts`
- `packages/ui/src/routes/api/host/providers/host-status/+server.ts`
- `packages/lib/src/control-plane/opencode-client.ts`

## Failure Domains

| Observation | Likely layer |
|---|---|
| Host API returns correct JSON but the page is wrong | Browser/UI state or response-shape handling |
| Host API fails while direct OpenCode works | Host route, capability, auth, or upstream-target issue |
| Host route and direct OpenCode both show missing provider data | OpenCode provider/auth configuration |
| Several services are missing or restarting | Compose files, profiles, secrets, or container health |
| `/api/host/*` fails on port `3800` | Expected non-admin assistant UI; use `openpalm admin` on port `3880` |
| `/admin/*` returns `404` | Expected current route contract |

## Host API Checks

```bash
curl -sS -b cookies.txt http://127.0.0.1:3880/api/host/containers/list | jq
curl -sS -b cookies.txt 'http://127.0.0.1:3880/api/host/containers/events?since=1h' | jq
curl -sS -b cookies.txt http://127.0.0.1:3880/api/host/config/validate | jq
curl -sS -b cookies.txt 'http://127.0.0.1:3880/api/host/logs?service=assistant&tail=200'
```

The host admin is not a Compose service. Read its own logs from the terminal or
service manager that launched `openpalm admin`.

## Compose Checks

Using the helper from the
[Manual Compose Runbook](manual-compose-runbook.md), repeat the real active
profiles:

```bash
op --profile guardian config --quiet
op --profile guardian config --services
op --profile guardian ps
op --profile guardian logs assistant guardian
```

Check that:

- the file list uses managed `system/stack/` files plus `config/stack/custom.compose.yml`
- `state/stack.env` is the only `--env-file`
- raw Compose received every active `--profile`
- delegated secrets resolve under `state/secrets/`
- provider `auth.json` remains under `knowledge/secrets/`

## Practical Order

For a missing-provider symptom:

1. Inspect the browser request to `/api/host/providers`.
2. Call `/api/host/providers` with the session cookie.
3. Call OpenCode `/provider` and `/provider/auth` directly.
4. Call `/api/host/providers/host-status`.
5. Check assistant logs and host-admin stderr.
6. Validate the exact Compose profile set.

Stop at the first failing layer. Do not change Compose when the server payload
is already correct, and do not change UI code when OpenCode itself returns the
wrong data.
