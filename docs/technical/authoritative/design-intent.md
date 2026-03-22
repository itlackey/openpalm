# Design Intent

## Goals

- Entire stack can be managed with docker compose commands and a file editor.
- Management of the stack should be as simple as management secrets, configuration, and compose files under OP_HOME (~/.openpalm)
- All tooling should exist to simplify the management of these files, including the setup wizard that seeds the original files and sets the initial configuration

### Stack

- OpenCode providers are configured once and shared between assistant, guardian, scheduler, and admin (optionally)
- The entire stack consists of compose overlay files, .env files (aka secrets), and service configuration files. Everything else is convience tooling on top of this foundation.
- stack.yaml exists as a configuration mapping/abstraction artifact that the optional tooling can use to manage the various .env and configuration files, and use the proper arguments for the docker compose commands.
- Services in the stack should have strict network, host access rules, and secret boundaries

### Assistant

- Assistant is an opencode service that can:
  - load secrets from the user vault
  - r/w to the stash and workspace
  - be extended by adding opencode extensions to the assistants mounted .config/opencode directory
  - provides /etc/opencode assets as the default assistant opencode extensions/configuration

