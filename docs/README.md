# docs

Documentation index for OpenPalm.

## Getting started

| Document | Description |
|---|---|
| [setup-guide.md](setup-guide.md) | Installation, updating, troubleshooting |
| [how-it-works.md](how-it-works.md) | Architecture overview and data flow |
| [managing-openpalm.md](managing-openpalm.md) | Configuration, channels, secrets, access control, automations |

## Architecture (must-read for contributors)

| Document | Description |
|---|---|
| [core-principles.md](core-principles.md) | **Authoritative.** 9 core goals, 4 security invariants, filesystem + volume-mount contracts |
| [directory-structure.md](directory-structure.md) | XDG three-tier layout (CONFIG / DATA / STATE) |
| [docker-dependency-resolution.md](docker-dependency-resolution.md) | **Mandatory.** Docker build patterns — no Bun in admin, no symlinks |

## Implementation rules

| Document | Applies to |
|---|---|
| [code-quality-principles.md](code-quality-principles.md) | All code |
| [bunjs-rules.md](bunjs-rules.md) | Guardian, channels, channels-sdk |
| [sveltekit-rules.md](sveltekit-rules.md) | Admin UI (`core/admin/`) |

## Reference

| Document | Description |
|---|---|
| [api-spec.md](api-spec.md) | Admin API endpoint contract |
| [environment-and-mounts.md](environment-and-mounts.md) | All env vars and volume mounts |
| [opencode-configuration.md](opencode-configuration.md) | OpenCode runtime integration |
| [community-channels.md](community-channels.md) | BaseChannel SDK for custom adapters |
| [docker-socket-proxy-migration.md](docker-socket-proxy-migration.md) | Socket proxy design and allowlist |
| [prd.md](prd.md) | MVP product requirements |
