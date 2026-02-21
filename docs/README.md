# OpenPalm Documentation

## Suggested reading order

If you are new to OpenPalm, read the docs in this order:

1. **[User Concepts](user-concepts.md)** -- Understand what OpenPalm is and how end users interact with it.
2. **[Admin Guide](admin-guide.md)** -- Set up and manage your OpenPalm instance.
3. **[Extensions Guide](extensions-guide.md)** -- Add capabilities to your assistant with skills, commands, agents, tools, and plugins.
4. **[Architecture](development/architecture.md)** -- Understand how the containers, gateway, and services fit together.
5. **[API Reference](development/api-reference.md)** -- Integrate programmatically with the gateway and admin APIs.

## All documentation

| Guide | What's inside |
|---|---|
| [CLI](cli.md) | Install methods, commands, flags, and building from source |
| [User Concepts](user-concepts.md) | What OpenPalm is and how end users interact with it |
| [Admin Concepts](admin-concepts.md) | Key concepts for administrators |
| [Admin Guide](admin-guide.md) | Installation, admin console, authentication |
| [Architecture](development/architecture.md) | Container inventory, data flow diagrams, URL routing |
| [API Reference](development/api-reference.md) | Service endpoints and payloads for gateway, admin, and channels |
| [Extensions Guide](extensions-guide.md) | Extension types and installing extensions |
| [Extensions Reference](reference/extensions-reference.md) | Technical reference for all extension types (API/schema details) |
| [Host System Reference](reference/host-system-reference.md) | Host paths, environment variables, system requirements |
| [Security](security.md) | Security controls by layer and why they exist |
| [Testing Plan](development/testing-plan.md) | Test strategy, coverage goals, and test categories |
| [Maintenance](admin/maintenance.md) | Backup, restore, upgrade, and rollback procedures |
| [Troubleshooting](troubleshooting.md) | Common issues and how to resolve them |

## Project READMEs

Each service has a README with implementation details. These are the source of truth for service-specific configuration and internals.

| Service | README |
|---|---|
| Admin service | [admin/README.md](../admin/README.md) |
| Gateway service | [gateway/README.md](../gateway/README.md) |
| Assistant service | [assistant/README.md](../assistant/README.md) |

## Admin operations

See [admin/](admin/README.md) for backup, restore, upgrade, and versioning guides.
