# OpenPalm documentation

OpenPalm 0.14 has one product promise: install a private personal agent with
persistent knowledge and recurring work, then access it through native
OpenCode or optional guarded MCP.

## User guides

| Document | Purpose |
|---|---|
| [Project README](../README.md) | Product overview and current 0.14 status |
| [Installation](installation.md) | Fresh install, provider readiness, and first connection |
| [Managing OpenPalm](managing-openpalm.md) | Knowledge, schedules, access policies, backup, and lifecycle |
| [Moving to 0.14](operations/migration-to-0.14.md) | Fresh-install and allowlisted-import contract |
| [Admin setup verification](operations/admin-setup-verification.md) | Real Electron and Docker setup acceptance runbook |
| [Claude Desktop](claude-desktop.md) | Local Claude MCPB connection |
| [Remote MCP](remote-mcp.md) | Public HTTPS and OAuth resource-server deployment |
| [Discord](portals/discord-setup.md) | Default-deny Discord adapter |
| [Slack](portals/slack-setup.md) | Default-deny Slack adapter |

## Maintained technical contracts

| Document | Purpose |
|---|---|
| [Core principles](technical/core-principles.md) | Normative 0.14 product, security, data, and scope contract |
| [Architecture](technical/architecture.md) | Runtime components and trust paths |
| [Runtime foundations](technical/foundations.md) | Filesystem, service, credential, and scheduler implementation |
| [Guardian MCP API](technical/api-spec.md) | Guarded remote protocol |
| [Environment and mounts](technical/environment-and-mounts.md) | Runtime variables, mounts, secrets, and networks |
| [OpenCode configuration](technical/opencode-configuration.md) | Agent profiles and provider ownership |
| [Testing workflow](technical/testing-workflow.md) | Active local and CI checks |
| [Release workflow](operations/release.md) | Images, CLI, optional artifacts, and release gate |

Older release documentation is retained in Git history, not in the maintained
documentation tree. The [core principles](technical/core-principles.md) are
the source of truth when behavior and prose disagree.
