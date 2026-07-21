# Diagnostic Playbook

Practical troubleshooting guide for OpenPalm operators and contributors. This is
based on the provider-display debugging path, but the workflow generalizes well
to most "the UI looks wrong, but I do not know which layer is broken" issues.

## Authenticating to the admin API

The admin API uses a session **cookie** (`op_session`), not the login password
directly. Log in once to a cookie jar, then pass it to every authenticated call:

```bash
# Obtain a session cookie (replace with your UI login password).
curl -sS -c cookies.txt -X POST http://localhost:3880/admin/auth/login \
  -H 'content-type: application/json' \
  -d "{\"password\":\"$OP_UI_LOGIN_PASSWORD\"}"

# Then reuse it on every admin call below:
#   curl -sS -b cookies.txt http://localhost:3880/admin/...
```

> The host UI port defaults to `3880` (`OP_HOST_UI_PORT`). The examples below
> assume you have `cookies.txt` from the step above.

## Common Troubleshooting Workflow

1. Reproduce the issue once and write down the exact symptom.
2. Decide which layer is first failing: browser UI, admin API, OpenCode, or container/config.
3. Check the request path from the outside in:
   - browser network request
   - admin route response
   - downstream OpenCode or service response
   - container health, logs, env, and compose wiring
4. Prefer one known-good direct check per layer before reading a lot of code.
5. Only after the failing layer is isolated, read the relevant source files.

For provider display specifically, the usual path is:

```text
Admin UI component
  -> GET /admin/providers
    -> admin route
      -> OpenCode GET /provider
      -> OpenCode GET /provider/auth
```

Relevant code paths:

- `packages/ui/src/lib/components/providers/ConnectSheet.svelte`
- `packages/ui/src/lib/components/providers/ProvidersPanel.svelte`
- `packages/ui/src/routes/admin/providers/+server.ts`
- `packages/lib/src/control-plane/opencode-client.ts`

## Distinguishing the Failure Domain

| If this is true | Most likely class | What to inspect next |
|---|---|---|
| Browser request succeeds and returns correct JSON, but the page is empty or wrong | UI issue | Browser console, Svelte component state, response-shape assumptions |
| Browser request fails or returns wrong JSON, but downstream services look healthy | Admin API issue | Admin route code, admin logs, auth headers, request/response shape |
| Admin route is thin and the downstream OpenCode call is empty, failing, or using the wrong path | OpenCode issue | OpenCode endpoint inventory, `OP_OPENCODE_URL`, OpenCode reachability |
| Multiple endpoints fail, services restart, or health checks are bad | Container/config issue | Compose status, env files, addon overlays, Docker events, config validation |

## Concrete Checks By Layer

### 1. UI issue

Start here when `/admin/providers` returns the data you expect, but the
UI still does not render it correctly.

- Browser DevTools Network: inspect `/admin/providers`
- Browser DevTools Console: look for runtime errors, hydration errors, and failed `fetch`
- Confirm the response shape matches what the component expects:
  - `data.providers`
  - `provider.connected`
  - `provider.models`
  - `provider.authMethods`
- Read the consuming components:
  - `packages/ui/src/lib/components/providers/ConnectSheet.svelte`
  - `packages/ui/src/lib/components/providers/ProvidersPanel.svelte`

Useful check from the host:

```bash
curl -sS -b cookies.txt http://localhost:3880/admin/providers | jq
```

If that payload is correct and the browser still renders incorrectly, stay in the
UI layer.

### 2. Admin API issue

Start here when the UI request itself fails, returns the wrong shape, or behaves
differently from the downstream service.

Useful endpoints:

- `GET http://localhost:3880/health`
- `GET http://localhost:3880/admin/providers/host-status`
- `GET http://localhost:3880/admin/providers`
- `GET http://localhost:3880/admin/logs?service=assistant&tail=200`
- `GET http://localhost:3880/admin/config/validate`

Useful commands:

```bash
curl -sS http://localhost:3880/health | jq
curl -sS -b cookies.txt http://localhost:3880/admin/providers/host-status | jq
curl -sS -b cookies.txt http://localhost:3880/admin/providers | jq
curl -sS -b cookies.txt "http://localhost:3880/admin/logs?service=assistant&tail=200"
```

Key lessons from the provider-display path:

- the admin route is in `packages/ui/src/routes/admin/providers/+server.ts`
- it merges OpenCode provider data with auth-method data
- the route can look broken even when the UI is fine if OpenCode returns an unexpected shape

### 3. OpenCode issue

Start here when the admin route is mostly a pass-through and the real failure is
downstream.

Important details:

- OpenCode provider inventory is on `/provider`, not `/providers`
- OpenCode auth metadata is on `/provider/auth`
- OpenCode does not expose a normal `/health` endpoint; the shared client treats `/provider` as the availability probe
- the configured upstream for admin is controlled by `OP_OPENCODE_URL`

Useful checks:

```bash
curl -sS http://localhost:3810/provider | jq
curl -sS http://localhost:3810/provider/auth | jq
curl -sS -b cookies.txt http://localhost:3880/admin/providers/host-status | jq
```

Also verify which OpenCode runtime the admin UI is actually targeting. In
confusing cases, check the admin (host) process environment or logs:

```bash
# Look for the openpalm process and its config
ps aux | grep "openpalm"
cat ~/.openpalm/knowledge/env/stack.env | grep -E "OP_OPENCODE|OPENCODE_PORT"
```

Read these files if the behavior does not match the docs:

- `packages/lib/src/control-plane/opencode-client.ts`
- `packages/ui/src/lib/server/opencode/{catalog,config,http}.ts`
- `docs/technical/api-spec.md`
- `docs/technical/opencode-configuration.md`

### 4. Container or config issue

Start here when endpoints are unavailable, multiple layers fail, or behavior is
inconsistent across restarts.

Useful commands with the helper from `docs/operations/manual-compose-runbook.md`:

```bash
op config --quiet
op config --services
op ps
op logs assistant
op logs guardian
```

> The admin UI is a **host process** (`openpalm ui serve`), not a compose
> service — there is no `admin` container to `op logs`. Read its output from the
> terminal/service that runs `openpalm`.

Useful admin endpoints:

- `GET /admin/containers/list`
- `GET /admin/containers/events?since=1h`
- `GET /admin/containers/stats`
- `GET /admin/config/validate`

Useful checks from the host:

```bash
curl -sS -b cookies.txt http://localhost:3880/admin/containers/list | jq
curl -sS -b cookies.txt "http://localhost:3880/admin/containers/events?since=1h" | jq
curl -sS -b cookies.txt http://localhost:3880/admin/config/validate | jq
```

Especially check:

- whether `OP_OPENCODE_URL` points to the intended runtime
- whether the admin UI can reach the assistant OpenCode at `:4096`
- whether the stack has restarted onto a different env/config than the one you think is live

## Practical Triage Order

When the symptom is "providers are missing or not displayed":

1. Browser network request to `/admin/providers`
2. Direct `curl` to `/admin/providers`
3. Direct `curl` to OpenCode `/provider` and `/provider/auth`
4. `GET /admin/providers/host-status`
5. `op logs assistant` (and the host `openpalm` process output for the UI)
6. `GET /admin/config/validate`

This order usually isolates the broken layer in a few minutes.

## What Would Have Made This Easier

- a maintained route map from UI component -> admin route -> downstream service endpoint
- a short endpoint inventory for OpenCode, especially that `/provider` is the canonical probe and list endpoint
- a single provider-debug page or script that shows raw browser payload, raw admin payload, and raw OpenCode payload side by side
- stronger request ID propagation from browser -> admin logs -> OpenCode logs
- explicit browser-console guidance in the main troubleshooting docs
- production source maps, or at least easier stack traces, for admin UI debugging
- a clearer doc section on how the admin UI proxies to the assistant OpenCode at `:4096`
- an operator-facing list of the most important env vars for this path, especially `OP_OPENCODE_URL` and `OPENCODE_PORT`
- a generated endpoint inventory for the admin API and OpenCode API so contributors do not have to infer paths from source
- a one-command diagnostics report for provider wiring, not just general stack health

## Rule Of Thumb

If the browser payload is wrong, debug the server. If the server payload is wrong,
debug the downstream service. If every layer is flaky, debug compose, env, and
container state before touching UI code.
