# Admin API Conventions

The current route inventory is maintained in
[`ui-route-map.md`](ui-route-map.md#api-routes). Route handlers under
`packages/ui/src/routes/**/+server.ts` and their tests are the payload-level
source of truth. This document defines the cross-route contract and the few
security-sensitive behaviors callers must not infer.

## Process Surfaces

- A host admin process normally listens at `http://127.0.0.1:3880`.
- The assistant image serves the same UI build as a non-admin child on container
  port `3000`.
- `/api/host/*` exists only where host capabilities are available.
- `/api/assistant/*` exposes the bounded assistant-settings capability surface.
- `/admin` and `/admin/*` are not aliases and return `404`.

## Authentication

`POST /api/auth/login` accepts the UI login password and issues `op_session`.
The cookie contains a stateless HMAC-signed expiry token, not the password or an
admin bearer token. Its attributes are:

- `HttpOnly`
- `SameSite=Lax`
- `Path=/`
- a 14-day `Max-Age`
- `Secure` only when the request arrived over HTTPS, directly or through a
  trusted `x-forwarded-proto` value

State-changing browser requests are also subject to the server's Origin check.
The retired `x-admin-token` and host `Authorization: Bearer` fallbacks are not
accepted.

After setup, protected endpoints require a valid session. Host routes then
apply a second `requireCapability('host:...')` gate and return
`403 capability_not_available` when the serving process has no host capability.

## Setup Gate

First-run `/setup` and `/api/setup/*` access is not generally public:

- the process must expose `host:setup`
- remote setup is denied unless the narrow documented remote-setup opt-in is
  active
- after setup completes, rerunning setup requires an admin session

These checks are centralized in `packages/ui/src/hooks.server.ts`.

## Response Conventions

Protected route failures normally use:

```json
{
  "error": "string_code",
  "message": "human readable",
  "details": {},
  "requestId": "request correlation id"
}
```

Callers may send `x-request-id`; the server creates one when absent. Health and
transparent proxy routes may use their native upstream shape instead.

## Route Families

| Namespace | Purpose | Primary guard |
|---|---|---|
| `/health`, `/api/runtime`, `/api/runtime-config` | Liveness and credential-free launcher context | Public |
| `/api/auth/*` | Session lifecycle | Login public; session/logout use session state |
| `/api/setup/*` | First-run host setup | Setup capability, locality, then admin after completion |
| `/api/assistant/*` | Persona, model, and assistant AKM settings | Session plus assistant-settings capability |
| `/api/connections/pairing` | Mint a one-time Guardian direct-principal pairing code | Session plus host stack-write capability |
| `/api/host/*` | Docker, lifecycle, addons, providers, secrets, versions, recovery, and diagnostics | Session plus route-specific host capability |
| `/voice/*` | Same-origin pass-through to local voice | Session; `503` when unavailable |
| `/guardian/health` | Guardian reachability probe | Public |

See `ui-route-map.md` for the complete current endpoint list.

## Secrets Contract

Generic host secret actions route names to one of two stores:

- OpenCode provider auth remains in `knowledge/secrets/auth.json`.
- Delegated UI, OpenCode-server, Guardian, API, portal, and bot credentials live
  under `private/secrets/`.

Secret-list responses expose metadata, not values. `state/stack.env` is
non-secret and secret-looking keys are rejected or relocated through the
name-routed secret writer.

## Configuration Validation

`GET /api/host/config/validate` performs the current narrow bootability check:

1. `state/stack.env` must exist.
2. `private/secrets/op_ui_login_password` must be present and non-empty.

It does not claim to run a complete Compose, registry, provider, or filesystem
audit. Compose preflight and the dedicated diagnostics/secret-audit paths cover
their own concerns.

## Provider Import

Host OpenCode import merges provider configuration and credentials without
overwriting conflicts unless requested. It best-effort pushes imported
non-Anthropic credentials to the running assistant OpenCode process, then
restarts the assistant and any enabled Guardian consumer so disk credentials
are reloaded. Per-provider push or restart failures are reported without
rolling back the completed file import.

## Guardian HTTP Surfaces

Guardian is not authenticated by `op_session`:

- `/oc/*` uses principal HTTP Basic authentication and ownership enforcement.
- `/stats` and principal administration use the Guardian admin bearer token and
  fail closed when it is absent.
- the OpenAI/Anthropic-compatible listener uses its dedicated API key and an
  internal Guardian principal.

See [`environment-and-mounts.md`](environment-and-mounts.md) and the Guardian
package tests for listener and response details.
