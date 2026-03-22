# Design Intent

## Goals

- OpenCode providers are configured once and shared between assistant, guardian, scheduler, and admin (optionally)
- Assistant is an opencode service that can:
  - load secrets from the user vault
  - r/w to the stash and workspace
  - be extended by adding opencode extensions to the assistants mounted .config/opencode directory
  - provides /etc/opencode assets as the default assistant opencode extensions/configuration
