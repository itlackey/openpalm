# OpenPalm Guardian Container

Guardian source lives in `packages/guardian/`. This directory contains its
image build and entrypoint assets.

Guardian is a profile-gated ingress service, not an always-on core container.
It is deployed for `api`, `discord`, `slack`, or `gateway` ingress — or
directly, via the bare `guardian` profile, when a guardian access toggle or a
remote tunnel requires it — and is the only path from those clients to the
assistant.

## Thin-Host Runtime

The image packs the local Guardian candidate, its external dependencies, and
OpenCode tooling so the default path boots without resolving public
`@openpalm` packages. The entrypoint keeps an explicit package/version override
seam for downstream distributions; with no override it uses the baked package.

Runtime state is bind-mounted under `/opt/openpalm/guardian`, while the package
lives at unshadowed `/opt/openpalm/guardian-pkg`.

## Proxy Pipeline

For each authenticated `/oc/*` request, Guardian:

1. Canonicalizes the path and rejects traversal.
2. Authenticates the principal with HTTP Basic credentials.
3. Enforces persisted session, permission, and question ownership.
4. Applies rate and stream/resource limits.
5. Validates prompt-bearing content.
6. Transparently proxies the native OpenCode method, path, query, body, and stream.

Guardian is not an endpoint allowlist or a second protocol. Failed policy checks
return an error before the request reaches the assistant.

## Content Validation

Content validation defaults **on in Guardian code and in the shipped Compose**.
Only explicit `0`, `false`, `no`, or `off` values disable it.

The pipeline uses a cheap heuristic screen first. Suspicious messages are sent
to the local OpenCode moderator on loopback port `4097`. An `allow` verdict is
forwarded, `flag` is forwarded and audited, and `block` is rejected.

Escalation fails closed: timeout, moderator failure, or an unparseable verdict
returns `403 content_blocked`.

Managed moderation instructions come from host `system/guardian/`, mounted
read-only at `/opt/openpalm/guardian-config`; the entrypoint republishes them
into `OPENCODE_CONFIG_DIR` (`/etc/opencode`), a regenerable copy bound from
`cache/guardian-opencode/runtime/` because OpenCode writes into every config
directory it loads. User model selection comes separately from
`config/guardian/`, mounted as Guardian's OpenCode global config.

## Credentials and Mounts

- Delegated principal, admin, API, bot, and OpenCode-server credentials originate in host `state/secrets/` and arrive through narrow Compose grants.
- Provider `knowledge/secrets/auth.json` remains the assistant-readable source; Guardian receives it as the `guardian_auth_json` Compose secret and copies it into its private home.
- Guardian does not mount the full `knowledge/` tree.
- Durable state is under `data/guardian/`; regenerable cache is under `cache/guardian/`; audit logs are under `data/logs/`.

## Listeners

| Listener | Default publication | Purpose |
|---|---|---|
| Internal `8080` | Docker networks only | Health, stats, and authenticated `/oc/*` proxy |
| Direct `3830` | `127.0.0.1:3830` | Optional direct `/oc/*` and MCP ingress |
| Admin `3831` | `127.0.0.1:3831` permanently | `/admin/principals` CRUD |
| Compatible API `8182` | `127.0.0.1:3821` (only when the `guardian.compose.api.yml` overlay is included) | OpenAI/Anthropic-compatible edge |
| Moderator `4097` | Container loopback only | Content-validation OpenCode process |

One compatible API listener; its host publish (`OP_API_PORT`) ships in the opt-in `guardian.compose.api.yml` overlay.

The direct listener returns `404` until `GUARDIAN_DIRECT_INGRESS=true`. TLS
termination is an operator reverse-proxy concern; Guardian serves plain HTTP.
Never expose the admin listener.

## Endpoints

| Method | Path | Listener | Purpose |
|---|---|---|---|
| `GET` | `/health` | Internal/direct | Liveness |
| `GET` | `/health/ready` | Internal | Readiness |
| `GET` | `/stats` | Internal | Token-protected runtime stats |
| `*` | `/oc/*` | Internal/direct | Authenticated native OpenCode proxy |
| `*` | `/mcp` | Direct | Optional MCP gateway |
| `POST/GET/...` | `/admin/principals...` | Admin `3831` | Principal management |

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Internal gateway port |
| `OP_ASSISTANT_URL` | `http://assistant:4096` | Assistant upstream |
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Managed Guardian OpenCode config |
| `GUARDIAN_CONTENT_VALIDATION` | On | Explicit falsy value opts out |
| `GUARDIAN_MODERATION_URL` | `http://127.0.0.1:4097` | Local moderator |
| `GUARDIAN_MODERATION_THRESHOLD` | `3` | Heuristic escalation threshold |
| `GUARDIAN_MODERATION_TIMEOUT_MS` | `4000` | Classification timeout |
| `GUARDIAN_DIRECT_INGRESS` | `false` | Enable direct listener routes |
| `GUARDIAN_CORS_ALLOWED_ORIGINS` | Empty | Exact browser origins for direct access |
| `GUARDIAN_SESSION_ACTIVE_GRACE_MS` | `86400000` (24 hours) | Recent-use window that exempts active sessions from ownership eviction |
| `GUARDIAN_RECONCILE_INTERVAL_MS` | `300000` (5 minutes) | Orphan-session reconciliation cadence; `0` disables periodic sweeps |
| `GUARDIAN_ADMIN_TOKEN_FILE` | Required for admin calls | Admin bearer-token file |
| `GUARDIAN_MCP_TOKEN_FILE` | Required for MCP | MCP bearer-token file |

## Downstream Overrides

The shipped stack does not need runtime package configuration. Downstream
distributions may set `OP_GUARDIAN_NPM_VERSION`, `OP_GUARDIAN_PACKAGE`, and
`OP_GUARDIAN_ENTRY`, optionally with a private-registry npmrc. Doing so replaces
the image-reviewed default package path and may require a registry install on
container recreation.

## Development

```bash
cd packages/guardian
bun run src/server.ts
bun test
```

From the repository root:

```bash
bun run guardian:dev
bun run guardian:test
```
