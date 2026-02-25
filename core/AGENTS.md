# Core Workspace

## Most important rules
- Maintain strict boundaries:
  - Admin = config/render/apply UX
  - Gateway = ingress/security/intake
  - Assistant = runtime/extensions
- Keep channels isolated from assistant internals; ingress flows through Gateway.
- Keep generated artifacts deterministic and aligned with DATA/STATE/CONFIG contracts.
- For new core containers, update release/version workflow files listed in root `AGENTS.md`.

## Key links
- `core/admin/AGENTS.md`
- `core/gateway/AGENTS.md`
- `core/assistant/AGENTS.md`
- `dev/docs/architecture.md`
