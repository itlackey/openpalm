# OpenPalm Documentation

## Suggested reading order

If you are new to OpenPalm, read the docs in this order:

1. **[User Concepts](user-concepts.md)** -- Understand what OpenPalm is and how end users interact with it.
2. **[Admin Guide](admin-guide.md)** -- Set up and manage your OpenPalm instance.
3. **[Extensions Guide](extensions-guide.md)** -- Add capabilities to your assistant with skills, commands, agents, tools, and plugins.
4. **[Architecture](development/architecture.md)** -- Understand how the containers, gateway, and services fit together.
5. **[API Reference](development/api-reference.md)** -- Integrate programmatically with the gateway and admin APIs.

## All documentation

## Compose files at a glance

- Runtime compose source of truth: `assets/state/docker-compose.yml`.
- Dev-only root overlay: `docker-compose.dev.yml`.

| Guide | What's inside |
|---|---|
| [CLI](cli.md) | Install methods, commands, flags, and building from source |
| [User Concepts](user-concepts.md) | What OpenPalm is and how end users interact with it |
| [Admin Concepts](admin-concepts.md) | Key concepts for administrators |
| [Admin Guide](admin-guide.md) | Installer details, admin console, authentication |
| [Architecture](development/architecture.md) | Container inventory, data flow diagrams, URL routing |
| [Architecture Simplification Plan](draft/architecture-simplification-plan.md) | Gap analysis and phased plan to complete stack-spec/generator simplification work |
| [Stack Spec Refactor Plan](development/stack-spec-secrets-connections-removal-plan.md) | Detailed checklist for removing stack-spec secrets/connections and adding host channel exposure |
| [API Reference](development/api-reference.md) | Service endpoints and payloads for gateway, admin, and channels |
| [Extensions Guide](extensions-guide.md) | How to build and install extensions (developer tutorial) |
| [Extensions Reference](refenence/extensions-reference.md) | Technical reference for all extension types (API/schema details) |
| [Extensions Analysis](draft/extensions-analysis.md) | Architecture analysis of the extension system (design rationale) |
| [Plugin Authoring](development/plugin-authoring.md) | How to write OpenCode plugins with lifecycle hooks |
| [Docker Compose Guide](docker-compose-guide.md) | Hosting, observability, extending the stack |
| [Host System Reference](refenence/host-system-reference.md) | Host paths, environment variables, system requirements |
| [Implementation Guide](draft/implementation-guide.md) | Design rationale and build order |
| [Security](security.md) | Security controls by layer and why they exist |
| [Testing Plan](development/testing-plan.md) | Test strategy, coverage goals, and test categories |
| [Backup & Restore](backup-restore.md) | How to back up and restore OpenPalm data |
| [Upgrade Guide](upgrade-guide.md) | How to upgrade OpenPalm to a new version |
| [Troubleshooting](troubleshooting.md) | Common issues and how to resolve them |
