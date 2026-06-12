# Registry Status

OpenPalm no longer uses a runtime registry catalog for first-party addons or automations.

First-party optional services are defined in the fixed compose files under `config/stack/`:

- `services.compose.yml`
- `channels.compose.yml`

Activation is recorded in `knowledge/env/stack.env` as `OP_ENABLED_ADDONS`. OpenPalm resolves those names to Compose profiles when it builds the Docker Compose command. Explicit Docker Compose `--profile addon.<name>` arguments remain valid for manual runs. OpenPalm does not generate `addons.compose.yml` and does not write `enabled-addons.json`.

User custom services and overlays belong in `config/stack/custom.compose.yml`.

Automation tasks are AKM-owned stash files under `knowledge/tasks/`. OpenPalm does not track task enablement in a registry; AKM reads each task file's own `enabled` state.
