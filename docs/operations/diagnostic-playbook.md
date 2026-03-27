# Diagnostic Playbook

Practical troubleshooting guide for OpenPalm operators and contributors. This is
based on the provider-display debugging path, but the workflow generalizes well
to most "the UI looks wrong, but I do not know which layer is broken" issues.

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
  -> GET /admin/opencode/providers
    -> admin route
      -> OpenCode GET /provider
      -> OpenCode GET /provider/auth
```

Relevant code paths:

- `packages/admin/src/lib/components/opencode/ConnectProviderSheet.svelte`
- `packages/admin/src/lib/components/CapabilitiesTab.svelte`
- `packages/admin/src/routes/admin/opencode/providers/+server.ts`
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

Start here when `/admin/opencode/providers` returns the data you expect, but the
UI still does not render it correctly.

- Browser DevTools Network: inspect `/admin/opencode/providers`
- Browser DevTools Console: look for runtime errors, hydration errors, and failed `fetch`
- Confirm the response shape matches what the component expects:
  - `data.providers`
  - `provider.connected`
  - `provider.models`
  - `provider.authMethods`
- Read the consuming components:
  - `packages/admin/src/lib/components/opencode/ConnectProviderSheet.svelte`
  - `packages/admin/src/lib/components/CapabilitiesTab.svelte`

Useful check from the host:

```bash
curl -sS -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3880/admin/opencode/providers | jq
```

If that payload is correct and the browser still renders incorrectly, stay in the
UI layer.

### 2. Admin API issue

Start here when the UI request itself fails, returns the wrong shape, or behaves
differently from the downstream service.

Useful endpoints:

- `GET http://localhost:3880/health`
- `GET http://localhost:3880/admin/opencode/status`
- `GET http://localhost:3880/admin/opencode/providers`
- `GET http://localhost:3880/admin/logs?service=admin&tail=200`
- `GET http://localhost:3880/admin/config/validate`

Useful commands:

```bash
curl -sS http://localhost:3880/health | jq
curl -sS -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3880/admin/opencode/status | jq
curl -sS -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3880/admin/opencode/providers | jq
curl -sS -H "x-admin-token: $ADMIN_TOKEN" "http://localhost:3880/admin/logs?service=admin&tail=200"
```

Key lessons from the provider-display path:

- the admin route is in `packages/admin/src/routes/admin/opencode/providers/+server.ts`
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
curl -sS http://localhost:4096/provider | jq
curl -sS http://localhost:4096/provider/auth | jq
curl -sS -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3880/admin/opencode/status | jq
```

If the admin addon is installed, also verify which OpenCode runtime the admin is
actually targeting. In confusing cases, inspect env inside the admin container:

```bash
docker compose exec admin sh -lc 'printenv OP_OPENCODE_URL OPENCODE_PORT OP_ADMIN_OPENCODE_PORT'
```

Read these files if the behavior does not match the docs:

- `packages/admin/src/lib/opencode/client.server.ts`
- `packages/lib/src/control-plane/opencode-client.ts`
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
op logs admin
op logs assistant
op logs guardian
```

Useful admin endpoints:

- `GET /admin/containers/list`
- `GET /admin/containers/events?since=1h`
- `GET /admin/containers/stats`
- `GET /admin/network/check`
- `GET /admin/config/validate`

Useful checks from the host:

```bash
curl -sS -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3880/admin/containers/list | jq
curl -sS -H "x-admin-token: $ADMIN_TOKEN" "http://localhost:3880/admin/containers/events?since=1h" | jq
curl -sS -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3880/admin/network/check | jq
curl -sS -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3880/admin/config/validate | jq
```

Especially check:

- whether the `admin` addon overlay is actually enabled
- whether `OP_OPENCODE_URL` points to the intended runtime
- whether you are mixing up assistant OpenCode `:4096` and admin OpenCode `:3881`
- whether the stack has restarted onto a different env/config than the one you think is live

## Practical Triage Order

When the symptom is "providers are missing or not displayed":

1. Browser network request to `/admin/opencode/providers`
2. Direct `curl` to `/admin/opencode/providers`
3. Direct `curl` to OpenCode `/provider` and `/provider/auth`
4. `GET /admin/opencode/status`
5. `op logs admin` and `op logs assistant`
6. `GET /admin/config/validate` and `GET /admin/network/check`

This order usually isolates the broken layer in a few minutes.

## What Would Have Made This Easier

- a maintained route map from UI component -> admin route -> downstream service endpoint
- a short endpoint inventory for OpenCode, especially that `/provider` is the canonical probe and list endpoint
- a single provider-debug page or script that shows raw browser payload, raw admin payload, and raw OpenCode payload side by side
- stronger request ID propagation from browser -> admin logs -> OpenCode logs
- explicit browser-console guidance in the main troubleshooting docs
- production source maps, or at least easier stack traces, for admin UI debugging
- a clearer doc section on assistant OpenCode `:4096` vs admin OpenCode `:3881`
- an operator-facing list of the most important env vars for this path, especially `OP_OPENCODE_URL`, `OPENCODE_PORT`, and `OP_ADMIN_OPENCODE_PORT`
- a generated endpoint inventory for the admin API and OpenCode API so contributors do not have to infer paths from source
- a one-command diagnostics report for provider wiring, not just general stack health

## Rule Of Thumb

If the browser payload is wrong, debug the server. If the server payload is wrong,
debug the downstream service. If every layer is flaky, debug compose, env, and
container state before touching UI code.
