# OpenPalm documentation

This index lists the maintained lean-stack documentation. OpenPalm is one
default Assistant container, an optional Guardian MCP gateway, optional
Discord/Slack adapters, a host CLI, and a separate static Admin utility.

## Start here

| Document | Purpose |
|---|---|
| [Project README](../README.md) | Product boundary, install, and common commands |
| [Installation](installation.md) | Fresh install and provider configuration |
| [Managing OpenPalm](managing-openpalm.md) | Lifecycle, intent, secrets, and custom Compose |
| [Discord](portals/discord-setup.md) | Default-deny Discord adapter setup |
| [Slack](portals/slack-setup.md) | Default-deny Slack adapter setup |
| [Lean migration](operations/migration-to-lean-stack.md) | Safe migration from the larger legacy stack |

## Architecture and contracts

| Document | Purpose |
|---|---|
| [Core principles](technical/core-principles.md) | Living product, security, filesystem, and complexity contract |
| [Architecture](technical/architecture.md) | Runtime topology and package graph |
| [Guardian MCP API](technical/api-spec.md) | The complete remote protocol surface |
| [Environment and mounts](technical/environment-and-mounts.md) | Variables, secrets, mounts, and networks |
| [OpenCode configuration](technical/opencode-configuration.md) | Trusted, remote, moderator, and scheduler configuration |
| [Package management](technical/package-management.md) | Workspaces, lockfile, image dependencies, and release units |
| [Deletion manifest](technical/deletion-manifest.md) | Exact legacy paths awaiting approval |

## Contributor and release workflows

| Document | Purpose |
|---|---|
| [Contributor guide](../.github/CONTRIBUTING.md) | Local setup and verification |
| [Testing workflow](technical/testing-workflow.md) | Active local and CI checks |
| [Release workflow](operations/release.md) | Three images, standalone CLI, Admin artifacts, and npm bootstrap |

## Historical documents

Other documents in this repository describe pre-lean releases, design
explorations, retired UI/API/addon features, or point-in-time reviews. They are
preserved for migration context until their exact paths are approved for
deletion. They are not normative and must not be used to infer an active
service, package, API, environment variable, or support promise.

When a historical document conflicts with the active code or maintained docs,
use the active behavior and update the living
[core principles](technical/core-principles.md) in the same change.
