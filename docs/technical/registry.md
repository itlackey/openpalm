# Registry Status

OpenPalm no longer uses a runtime registry catalog for first-party addons or automations.

First-party optional services are defined in the fixed compose files under `config/stack/`:

- `services.compose.yml`
- `channels.compose.yml`

Activation is profile-based through `COMPOSE_PROFILES` in `config/stack/stack.env` or explicit Docker Compose `--profile addon.<name>` arguments. OpenPalm does not generate `addons.compose.yml` and does not write `enabled-addons.json`.

User custom services and overlays belong in `config/stack/custom.compose.yml`.

Automation tasks are AKM-owned stash files under `stash/tasks/`. OpenPalm does not track task enablement in a registry; AKM reads each task file's own `enabled` state.
