# OpenPalm Documentation

Documentation is organized by audience and proximity to code.

## User guides

| Guide | What's inside |
|---|---|
| [CLI](cli.md) | Install methods, commands, flags, and building from source |
| [User Concepts](user-concepts.md) | What OpenPalm is and how end users interact with it |

## Admin and operations

Guides for setting up, securing, maintaining, and troubleshooting a running instance:

→ **[admin/docs/](../admin/docs/README.md)**

| Guide | What's inside |
|---|---|
| [Admin Guide](../admin/docs/admin-guide.md) | Installation, admin console, authentication |
| [Admin Concepts](../admin/docs/admin-concepts.md) | Extensions, secrets, channels, automations, gateway |
| [Security](../admin/docs/security.md) | Defense-in-depth security model |
| [Host System Reference](../admin/docs/host-system-reference.md) | Host paths, environment variables, XDG layout |
| [Maintenance](../admin/docs/maintenance.md) | Backup, restore, upgrade, rollback |
| [Versioning](../admin/docs/versioning.md) | Release process and CI workflows |
| [Troubleshooting](../admin/docs/troubleshooting.md) | Common issues and fixes |

## Developer references

Guides for building features, writing extensions, and integrating with APIs:

→ **[dev/docs/](../dev/docs/README.md)**

| Guide | What's inside |
|---|---|
| [Architecture](../dev/docs/architecture.md) | Container inventory, data flow, URL routing |
| [API Reference](../dev/docs/api-reference.md) | All service endpoints: gateway, admin, channels |
| [Extensions Guide](../dev/docs/extensions-guide.md) | Extension types and installing extensions |
| [Extensions Reference](../dev/docs/extensions-reference.md) | Technical reference for all extension types |
| [Testing Plan](../dev/docs/testing-plan.md) | Test strategy and coverage goals |
| [Contributor Checklist](../dev/docs/contributor-checklist.md) | Architecture-safe change checklist |

## Project READMEs

Each service and channel has a README with implementation details co-located with its code.

| Service | README |
|---|---|
| Admin service | [admin/README.md](../admin/README.md) |
| Gateway service | [gateway/README.md](../gateway/README.md) |
| Assistant service | [assistant/README.md](../assistant/README.md) |
| Chat channel | [channels/chat/README.md](../channels/chat/README.md) |
| Discord channel | [channels/discord/README.md](../channels/discord/README.md) |
| Voice channel | [channels/voice/README.md](../channels/voice/README.md) |
| Telegram channel | [channels/telegram/README.md](../channels/telegram/README.md) |
| Webhook channel | [channels/webhook/README.md](../channels/webhook/README.md) |

