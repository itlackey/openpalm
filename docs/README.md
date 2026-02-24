# OpenPalm Documentation

Documentation is organized by audience and proximity to code.

## User guides

| Guide | What's inside |
|---|---|
| [CLI](cli.md) | Install methods, commands, flags, and building from source |
| [User Concepts](concepts.md) | What OpenPalm is and how end users interact with it |

## Admin and operations

Guides for setting up, securing, maintaining, and troubleshooting a running instance:

→ **[core/admin/docs/](../core/admin/docs/README.md)**

| Guide | What's inside |
|---|---|
| [Admin Guide](../core/admin/docs/admin-guide.md) | Installation, admin console, authentication |
| [Admin Concepts](../core/admin/docs/admin-concepts.md) | Extensions, secrets, channels, automations, gateway |
| [Security](security.md) | Defense-in-depth security model |
| [Host System Reference](host-system-reference.md) | Host paths, environment variables, XDG layout |
| [Maintenance](maintenance.md) | Backup, restore, upgrade, rollback |
| [Versioning](../dev/docs/versioning.md) | Release process and CI workflows |
| [Changelog](../CHANGELOG.md) | Platform release notes across all projects |
| [Troubleshooting](troubleshooting.md) | Common issues and fixes |

## Developer references

Guides for building features, writing extensions, and integrating with APIs:

→ **[dev/docs/](../dev/docs/README.md)**

| Guide | What's inside |
|---|---|
| [Architecture](../dev/docs/architecture.md) | Container inventory, data flow, URL routing |
| [API Reference](../dev/docs/api-reference.md) | All service endpoints: gateway, admin, channels |
| [Testing Plan](../dev/docs/testing-plan.md) | Test strategy and coverage goals |
| [CI Brittleness Report](../dev/docs/ci-brittleness-report.md) | CI risks, mitigation, and test tiering |
| [Contributor Checklist](../dev/docs/contributor-checklist.md) | Architecture-safe change checklist |

## Project READMEs

Each service and channel has a README with implementation details co-located with its code.

| Service | README |
|---|---|
| Admin service | [core/admin/README.md](../core/admin/README.md) |
| Gateway service | [core/gateway/README.md](../core/gateway/README.md) |
| Assistant service | [core/assistant/README.md](../core/assistant/README.md) |
| Chat channel | [channels/chat/README.md](../channels/chat/README.md) |
| Discord channel | [channels/discord/README.md](../channels/discord/README.md) |
| Voice channel | [channels/voice/README.md](../channels/voice/README.md) |
| Telegram channel | [channels/telegram/README.md](../channels/telegram/README.md) |
| Webhook channel | [channels/webhook/README.md](../channels/webhook/README.md) |
| API-compatible channel | [channels/api/README.md](../channels/api/README.md) |
