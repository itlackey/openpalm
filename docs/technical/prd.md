# OpenPalm MVP PRD (Current-State)

## Product goal

OpenPalm delivers a local-first AI platform with a strict control plane:

- Admin is the only Docker orchestrator.
- Guardian is the only channel ingress.
- Assistant has no Docker socket and uses Admin API only.

## Non-negotiable constraints

1. File assembly, not template rendering.
2. XDG tier boundaries (`CONFIG_HOME`, `DATA_HOME`, `STATE_HOME`).
3. Guardian verification on all channel ingress (HMAC + replay + rate + payload).
4. LAN-first default exposure.

## Runtime architecture

Core services:

- `memory`
- `assistant`
- `guardian`
- `scheduler`

Optional services (add-ons):

- `admin`
- Channels (chat, discord, etc.)

Channel services are added via compose overlays from `stack/addons/`
and installed into `config/components/`.

## Filesystem model

- `config/`: user-owned persistent source of truth (`components/`, `automations/`, `assistant/`).
  Allowed writers: user direct edits; explicit admin UI/API config actions;
  assistant calls via authenticated/allowlisted admin APIs on user request.
- `vault/user/`: user-managed secrets (`user.env` with LLM keys).
- `vault/stack/`: system-managed secrets (`stack.env` with admin token, HMAC, paths).
- `data/`: persistent service data (memory, assistant, guardian, catalog).
- `logs/`: audit and debug logs.

Admin startup runs an idempotent auto-apply that syncs bundled stack
assets into the running configuration. Lifecycle apply/install/update is
non-destructive for existing user config files and only seeds missing defaults.

## Secrets model

- User-managed: `vault/user/user.env` (LLM provider keys, embedding config).
- System-managed: `vault/stack/stack.env` (admin token, HMAC secrets, host-detected
  infrastructure config, `CHANNEL_<NAME>_SECRET` — seeded by setup scripts, updated by admin).
- Env schemas and example files committed at `vault/` in the repo (no secret values).

## API scope (implemented)

- Lifecycle: `/admin/install`, `/admin/update`, `/admin/uninstall`
- Containers: `/admin/containers/list|up|down|restart`
- Channels: `/admin/channels`, `/admin/channels/install`, `/admin/channels/uninstall`
- Access scope: `/admin/access-scope`
- Artifacts: `/admin/artifacts`, `/admin/artifacts/:name`, `/admin/artifacts/manifest`
- Audit: `/admin/audit`
- Connections: `/admin/connections`, `/admin/connections/status`
- Automations: `/admin/automations`
- Installed: `/admin/installed`
- Guardian proxy: `/admin/guardian/health`

For full endpoint details, see [api-spec.md](./api-spec.md).

Not implemented in current code: setup wizard endpoints.

## MVP acceptance criteria

1. `install` brings up core stack via admin API orchestration.
2. Channel ingress flows channel → guardian → assistant with security checks.
3. Assistant can perform allowlisted admin actions without Docker socket access.
4. Operators can inspect configuration under `config/` and secrets in `vault/`.
5. Admin actions are authenticated and audit-logged.
6. Connections API manages LLM provider keys without manual file editing.
7. `upgrade` applies upstream stack and image updates.
9. Community channels can be built using the `@openpalm/channels-sdk` package
   and the `core/channel` Docker image.
