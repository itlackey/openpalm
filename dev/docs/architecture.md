# Architecture (v0.3.0)

## System shape
OpenPalm is a microservice platform with three layers:
1. **Channels** (`channels/*`) accept platform traffic.
2. **Gateway** (`core/gateway`) verifies/authenticates and routes intake.
3. **Assistant runtime** (`core/assistant`) executes extensions and model interactions.

`core/admin` manages install/setup, config render/apply, and lifecycle orchestration.

## Hard boundaries
- Channels talk to **Gateway only**.
- Gateway is the single ingress path to assistant.
- Admin orchestrates runtime, but does not process channel business logic.
- Shared generation/validation logic belongs in `packages/lib`.

## Request flow
1. Channel receives event from platform.
2. Channel forwards normalized payload to gateway.
3. Gateway validates signature/shape and rate limits.
4. Gateway runs `channel-intake` guardrails.
5. Gateway dispatches valid requests to assistant runtime.
6. Gateway records audit metadata and response outcome.

## Configuration and runtime contracts
- **Intent config**: `openpalm.yaml` (YAML-first).
- **Secrets**: `secrets.env` with scoped references `${SECRET_NAME}`.
- **Rendered runtime config**: generated from `packages/lib`.
- **Host directories**: `CONFIG`, `STATE`, and `DATA` with per-container subfolders.

## Extension model
- Core extensions are bundled from:
  - `core/assistant/extensions/`
  - `core/gateway/opencode/`
- User overrides may be mounted at runtime from host config locations.

## Network exposure
- Admin, gateway, assistant, and supporting services are host/LAN scoped.
- Caddy provides ingress routes for Admin UI, Assistant UI, and OpenMemory UI.
